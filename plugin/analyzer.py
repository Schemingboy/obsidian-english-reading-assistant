"""Local dependency parsing. JSON in/out; offsets use JavaScript UTF-16 units."""
import json
import sys

VERSION = "spacy-en-sm-3.8.0-r1"


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
            for part in chain:
                verbs.append(span(part.idx, part.idx + len(part), role=role, chain=explanation))

        cuts = {0, len(text)}
        for sentence in doc.sents:
            cuts.add(sentence.start_char)
            cuts.add(sentence.end_char)
            for token in sentence:
                if token.text in (",", ";", ":", "—"):
                    cuts.add(token.idx + len(token))
                # Phrase boundaries come from dependencies, never punctuation alone.
                if token.dep_ in ("advcl", "relcl", "ccomp", "prep", "agent"):
                    subtree = list(token.subtree)
                    if len(subtree) >= 3:
                        cuts.add(min(t.idx for t in subtree))
                if token.dep_ in ("nsubj", "nsubjpass"):
                    right = max(t.idx + len(t) for t in token.subtree)
                    if right < token.head.idx:
                        cuts.add(right)
        boundaries = sorted(cuts)
        chunks = []
        start = 0
        # ponytail: merge very short dependency fragments; no claim of one unique linguistic segmentation.
        for end in boundaries[1:]:
            if len(text[start:end].split()) < 3 and end != len(text) and not text[start:end].rstrip().endswith((".", "?", "!", ";")):
                continue
            if text[start:end].strip():
                chunks.append(span(start, end))
                start = end
        if chunks and start < len(text):
            chunks[-1] = span(next(i for i, v in enumerate(offsets) if v == chunks[-1]["start"]), len(text))
        results.append(dict(groups=chunks, predicates=sorted(verbs, key=lambda s: s["start"])))
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
