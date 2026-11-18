/* Reads a chain's results the same way on the live test player and the On-Demand report. */
window.VIF = window.VIF || {};
(function (VIF) {
    'use strict';

    /**
     * One AI model answer (a vlm[] entry) as findings: the description as prose, the things a
     * check named with its reasoning, or the fields of an answer in the user's own format.
     * Each finding is { label, reasoning, confidence, data, degraded }; no answer gives [].
     */
    function vlmAnswers(entry) {
        const degraded = !!(entry && entry.degraded);
        const raw = entry && typeof entry.content === 'string' ? entry.content.trim() : '';
        // Unescaping first would break the escapes inside a structured answer's strings.
        const content = raw.replace(/\\n/g, '\n').replace(/\\"/g, '"');
        if (!content) return [];
        const prose = [{ label: 'description', reasoning: content, confidence: null, data: null, degraded }];
        if (!entry.is_structured) return prose;
        let root;
        try { root = JSON.parse(raw); } catch (e) {
            try { root = JSON.parse(content); } catch (e2) { return prose; }
        }
        const listed = root && root.results;
        const items = Array.isArray(listed) ? listed.filter((item) => item && typeof item === 'object') : [];
        const named = Array.isArray(listed) && (listed.length === 0 || (items.length > 0 && 'class_name' in items[0]));
        if (!named) return [{ label: null, reasoning: null, confidence: null, data: root, degraded }];
        return items.map((item) => ({
            label: String(item.class_name ?? '').trim(),
            reasoning: String(item.reasoning ?? '').trim() || null,
            confidence: null,
            data: null,
            degraded
        }));
    }

    // A find's confidence, whether it came as a number or as the live stream's { avg }.
    function score(find) {
        const value = find && find.confidence;
        if (typeof value === 'number') return value;
        return value && typeof value.avg === 'number' ? value.avg : null;
    }
    function sure(value) { return typeof value === 'number' ? Math.round(value * 100) + '% sure' : null; }
    function where(box) {
        const sides = box && !Array.isArray(box) ? [box.x, box.y, box.w, box.h] : null;
        return sides && sides.every((n) => typeof n === 'number')
            ? 'box ' + box.w + '×' + box.h + ' at ' + box.x + ', ' + box.y
            : 'box ' + JSON.stringify(box);
    }
    function shorten(text, max) { return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text; }
    // The first three names; the step's own results list every find.
    function strongest(names) {
        return names.slice(0, 3).join(', ') + (names.length > 3 ? ' +' + (names.length - 3) + ' more' : '');
    }

    /** A step's finds of the same thing as one group each, strongest first: { name, items, best, tracks }. */
    function groups(detections) {
        const byClass = new Map();
        detections.forEach((d) => {
            const name = d.class_name || 'Result';
            if (!byClass.has(name)) byClass.set(name, []);
            byClass.get(name).push(d);
        });
        return Array.from(byClass, ([name, items]) => ({
            name,
            items,
            best: items.reduce((top, d) => (score(d) !== null && (top === null || score(d) > top) ? score(d) : top), null),
            tracks: new Set(items.map((d) => d.track_id).filter((id) => id != null)).size
        })).sort((a, b) => (b.best ?? -1) - (a.best ?? -1));
    }
    // A group in words after its name: "found 6 times · best 57% sure · 2 tracked objects".
    function groupDetail(group, type) {
        const many = group.items.length > 1;
        const tracked = type === 'motion' ? ['moving area', 'moving areas'] : ['tracked object', 'tracked objects'];
        return [
            many ? 'found ' + group.items.length + ' times' : null,
            group.best !== null ? (many ? 'best ' : '') + sure(group.best) : null,
            group.tracks ? group.tracks + ' ' + tracked[group.tracks === 1 ? 0 : 1] : null
        ].filter(Boolean).join(' · ');
    }

    // The service or AI model behind a step couldn't be reached, so finding nothing means nothing.
    function unreachable(ring) {
        return !!(ring.degraded || (ring.synthetic && ring.synthetic.degraded)
            || (Array.isArray(ring.vlm) && ring.vlm.some((entry) => entry && entry.degraded)));
    }

    /**
     * An AI model step's answers as findings, whether they came as the model's own text (every
     * step's results, On-Demand rows) or already read into detections (the last step's results).
     */
    function aiFindings(ring) {
        const vlm = ring.vlm || (ring.content ? [ring] : []);
        if (vlm.length) {
            return vlm.flatMap((item) => (item.content && typeof item.content === 'object'
                ? [{ label: null, reasoning: null, confidence: null, data: item.content, degraded: !!item.degraded }]
                : vlmAnswers(item)));
        }
        return (ring.detections || []).map((d) => ({ label: d.class_name ?? null, reasoning: d.reasoning || null,
            confidence: null, data: d.data && typeof d.data === 'object' ? d.data : null, degraded: false }));
    }

    // What one step found, in a few words; null when it found nothing.
    function ringFinding(ring) {
        const type = ring.detections_type || ring.detector_type;
        const synthetic = ring.synthetic || (type === 'synthetic' ? ring : null);
        if (synthetic) {
            if (synthetic.degraded || !synthetic.verdict) return null;
            return synthetic.verdict === 'synthetic' ? 'AI-generated video' : synthetic.verdict === 'real' ? 'real video' : synthetic.verdict;
        }
        if (type === 'vlm' || ring.vlm) {
            const found = aiFindings(ring);
            const prose = found.find((f) => f.label === 'description' && f.reasoning);
            if (prose) return '“' + shorten(prose.reasoning.replace(/\s+/g, ' '), 120) + '”';
            const named = found.filter((f) => f.label).map((f) => f.label);
            if (named.length) return strongest(Array.from(new Set(named)));
            const answer = found.find((f) => f.data);
            return answer ? shorten(Object.keys(answer.data).map((key) => key + ': ' + (answer.data[key] !== null
                && typeof answer.data[key] === 'object' ? JSON.stringify(answer.data[key]) : answer.data[key])).join(', '), 120) : null;
        }
        const detections = ring.detections || [];
        if (!detections.length) return null;
        return type === 'motion' ? 'movement' : strongest(groups(detections).map((group) => group.name));
    }
    /** What a clip's steps found, in one line, with movement only when nothing else turned up; null when nothing. */
    function clipFinding(rings) {
        const said = rings.map(ringFinding).filter(Boolean);
        const telling = said.filter((s) => s !== 'movement');
        const shown = Array.from(new Set(telling.length ? telling : said));
        return shown.length ? shown.join(' · ') : null;
    }

    VIF.chainResults = { vlmAnswers, aiFindings, score, sure, where, shorten, strongest, groups, groupDetail, unreachable, ringFinding, clipFinding };
})(window.VIF);
