"""Local dependency parsing. JSON in/out; offsets use JavaScript UTF-16 units."""
import json
import sys

VERSION = "spacy-en-sm-3.8.0-r2"


def analyze(nlp, texts):
    results = []
    for doc in nlp.pipe(texts, batch_size=16):
        text = doc.text
        offsets = [0]
        for char in text:
            offsets.append(offsets[-1] + (2 if ord(char) > 0xFFFF else 1))

        def span(start, end, **extra):
            return dict(start=offsets[start], end=offsets[end], text=text[start:end], **extra)

        verbs = []
        chains = []
        for token in doc:
            if token.pos_ not in ("VERB", "AUX") or token.dep_ in ("aux", "auxpass"):
                continue
            chain = sorted([token] + [c for c in token.children if c.dep_ in ("aux", "auxpass", "prt", "neg")], key=lambda t: t.i)
            finite = any("Fin" in t.morph.get("VerbForm") or t.tag_ == "MD" for t in chain)
            # Shared auxiliaries in coordinated verb phrases: has read and written.
            ancestor = token
            while not finite and ancestor.dep_ == "conj":
                ancestor = ancestor.head
                finite = any("Fin" in t.morph.get("VerbForm") or t.tag_ == "MD" for t in [ancestor, *ancestor.children] if t == ancestor or t.dep_ in ("aux", "auxpass"))
            infinitive = any(t.tag_ == "TO" for t in chain)
            if infinitive:
                finite = False
            if token.dep_ == "ROOT" and token.tag_ == "VB" and not infinitive:
                finite = True  # Imperative: Read the book.
            head = token
            while head.dep_ == "conj":
                head = head.head
            role = ("main" if head.dep_ == "ROOT" else "subordinate") if finite else "nonfinite"
            explanation = " ".join(t.text for t in chain)
            chains.append((chain[0].idx, chain[-1].idx + len(chain[-1])))
            for part in chain:
                verbs.append(span(part.idx, part.idx + len(part), role=role, chain=explanation))

        cuts = {0, len(text)}
        sentences = []
        for sentence in doc.sents:
            sentences.append(span(sentence.start_char, sentence.end_char))
            cuts.add(sentence.start_char)
            cuts.add(sentence.end_char)
            # Keep subordinate clauses intact at reading scale. Nested clauses stay
            # inside their parent; relative clauses stay with the noun they describe.
            clauses = []
            relatives = []
            for token in sentence:
                if token.dep_ in ("advcl", "ccomp", "relcl", "acl"):
                    subtree = list(token.subtree)
                    bounds = (min(t.idx for t in subtree), max(t.idx + len(t) for t in subtree))
                    (relatives if token.dep_ in ("relcl", "acl") else clauses).append(bounds)
            outer = [(a, b) for a, b in clauses if not any(c <= a and b <= d and (c, d) != (a, b) for c, d in clauses + relatives)]
            protected = outer + relatives + chains
            def inside(pos):
                return any(a < pos < b for a, b in protected)
            def cut(pos):
                if not inside(pos):
                    cuts.add(pos)
            for start, end in outer:
                cut(start)
                cut(end)
            for token in sentence:
                if token.text in (",", ";", ":", "—"):
                    cut(token.idx + len(token))
                if token.dep_ in ("prep", "agent") and token.head.dep_ in ("ROOT", "conj"):
                    subtree = list(token.subtree)
                    if len(subtree) >= 3:
                        cut(min(t.idx for t in subtree))
                if token.dep_ in ("nsubj", "nsubjpass"):
                    subtree = list(token.subtree)
                    right = max(t.idx + len(t) for t in token.subtree)
                    if len(subtree) >= 3 and right < token.head.idx:
                        cut(right)
        # Attach punctuation and following spaces to the preceding group. Never
        # merge a short clause into its neighbour merely to satisfy a word count.
        normalized = {0, len(text)}
        for pos in cuts:
            if pos == 0:
                continue
            while pos < len(text) and (text[pos].isspace() or text[pos] in ",;:.!?—"):
                pos += 1
            normalized.add(pos)
        boundaries = sorted(normalized)
        chunks = []
        start = 0
        for end in boundaries[1:]:
            if text[start:end].strip():
                chunks.append(span(start, end))
                start = end
        if chunks and start < len(text):
            chunks[-1] = span(next(i for i, v in enumerate(offsets) if v == chunks[-1]["start"]), len(text))
        results.append(dict(groups=chunks, predicates=sorted(verbs, key=lambda s: s["start"]), sentences=sentences))
    return dict(version=VERSION, blocks=results)


if __name__ == "__main__":
    try:
        import spacy
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
        request = json.load(sys.stdin)
        texts = request["texts"]
        if not isinstance(texts, list) or any(not isinstance(t, str) for t in texts) or sum(map(len, texts)) > 2_000_000:
            raise ValueError("Invalid or oversized text batch")
        print(json.dumps(analyze(spacy.load("en_core_web_sm", disable=["ner"]), texts), ensure_ascii=False))
    except Exception as error:
        print(type(error).__name__ + ": " + str(error), file=sys.stderr)
        sys.exit(1)
