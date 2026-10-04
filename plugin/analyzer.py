"""Local dependency parsing. JSON in/out; offsets use JavaScript UTF-16 units."""
import json
import sys
from spacy.language import Language

VERSION = "spacy-en-sm-3.8.0-r4"
COMPACT_WORDS = 8
MIN_MODIFIER_WORDS = 3
ERA_ABBREVIATIONS = {"B.C.", "A.D.", "B.C.E.", "C.E."}


@Language.component("reading_era_sentences")
def reading_era_sentences(doc):
    """Repair the common year + era + capitalized-sentence pattern before parsing."""
    for previous, token in zip(doc, doc[1:]):
        if token.text.upper() in ERA_ABBREVIATIONS:
            token.is_sent_start = False
        if previous.text.upper() in ERA_ABBREVIATIONS and previous.i > 0 and doc[previous.i - 1].like_num and token.text[:1].isupper():
            token.is_sent_start = True
    return doc


def reading_cuts(doc, chains):
    """Structural boundaries first; optional modifiers never create tiny pieces."""
    text = doc.text
    cuts = {0, len(text)}
    words = [0] * (len(text) + 1)
    for token in doc:
        if not token.is_punct and not token.is_space:
            words[token.idx + len(token)] += 1
    for i in range(1, len(words)):
        words[i] += words[i - 1]

    def size(a, b):
        return words[b] - words[a]

    def bounds(token):
        return token.left_edge.idx, token.right_edge.idx + len(token.right_edge)

    for sentence in doc.sents:
        begin, end = sentence.start_char, sentence.end_char
        cuts.update((begin, end))
        protected = list(chains)
        structural = set()
        modifiers = set()
        for token in sentence:
            a, b = bounds(token)
            if token.dep_ in ("advcl", "ccomp", "relcl", "acl", "xcomp"):
                compact = size(a, b) <= COMPACT_WORDS
                if compact:
                    protected.append((a, b))
                # Short relatives stay with their noun; long ones may unfold.
                if token.dep_ in ("advcl", "ccomp") or not compact:
                    structural.update((a, b))
            if token.pos_ in ("NOUN", "PROPN", "PRON", "ADJ", "NUM") and any(c.dep_ == "conj" for c in token.children):
                # Protect the short list itself, not every modifier and subsequent
                # semicolon-separated item swallowed by its dependency subtree.
                core = []
                core_start = token.left_edge.i
                for part in doc[core_start:token.i]:
                    if part.text in (";", ":"):
                        core_start = part.i + 1
                for part in doc[core_start:token.right_edge.i + 1]:
                    if part.dep_ in ("prep", "agent", "relcl", "acl") or part.text in (";", ":"):
                        break
                    core.append(part)
                if core and size(core[0].idx, core[-1].idx + len(core[-1])) <= COMPACT_WORDS:
                    protected.append((core[0].idx, core[-1].idx + len(core[-1])))
            if token.dep_ in ("nsubj", "nsubjpass") and b < token.head.idx and size(a, b) >= MIN_MODIFIER_WORDS:
                structural.add(b)
            if token.dep_ == "conj" and size(begin, end) > COMPACT_WORDS * 2:
                start = a
                if token.left_edge.i > sentence.start and doc[token.left_edge.i - 1].dep_ == "cc":
                    start = doc[token.left_edge.i - 1].idx
                    modifiers.add(start)
            if token.dep_ in ("prep", "agent"):
                # of/to/for + noun complements usually form a single concept.
                # Passive agents stay with the action ("ruled by ...").
                if token.lower_ == "of" or token.dep_ == "agent" or token.head.pos_ in ("ADJ", "ADV"):
                    continue
                if token.lower_ in ("to", "for") and token.head.pos_ in ("NOUN", "PROPN"):
                    continue
                if token.head.tag_ in ("VBG", "VBN") and token.head.i + 1 == token.i:
                    protected.append((token.head.idx, token.idx + len(token)))
                modifiers.add(a)

        # Short parentheses form one aside. Long ones may contain groups, but
        # neither opening nor closing delimiters become their own group.
        stack = []
        for token in sentence:
            if token.text in ("(", "["):
                stack.append(token.idx)
            elif token.text in (")", "]") and stack:
                a = stack.pop()
                b = token.idx + len(token)
                if size(a, b) <= COMPACT_WORDS:
                    protected.append((a, b))

        # Numeric ranges are one quantity, including an attached era suffix.
        for token in sentence:
            if not token.like_num:
                continue
            last = token
            for part in doc[token.i + 1:sentence.end]:
                if part.like_num or part.text in ("–", "-", "to", "and") or part.text.upper() in ERA_ABBREVIATIONS:
                    last = part
                    if part.text.upper() in ERA_ABBREVIATIONS:
                        break
                else:
                    break
            protected.append((token.idx, last.idx + len(last)))

        def inside(pos):
            return any(a < pos < b for a, b in protected)

        cuts.update(pos for pos in structural if not inside(pos))
        for token in sentence:
            pos = token.idx + len(token)
            if token.text in (";", ":") or token.text in (",", "—") and not inside(pos):
                cuts.add(pos)
        for pos in sorted(modifiers):
            if inside(pos) or not begin < pos < end:
                continue
            left = max(c for c in cuts if c < pos)
            right = min(c for c in cuts if c > pos)
            if size(left, pos) >= MIN_MODIFIER_WORDS and size(pos, right) >= MIN_MODIFIER_WORDS:
                cuts.add(pos)

    normalized = {0, len(text)}
    for pos in cuts:
        if not pos:
            continue
        # Keep leading conjunctions with their clause, not as an isolated sliver.
        prior = text[max(c for c in cuts if c < pos):pos].strip().strip("[]()").lower()
        if prior in ("and", "but", "or"):
            continue
        while pos < len(text) and (text[pos].isspace() or text[pos] in ",;:.!?—)]}’”"):
            pos += 1
        normalized.add(pos)
    boundaries = sorted(normalized)
    # Parser sentence starts may isolate an opening quote. Attach punctuation
    # by direction; do not use word-count merging across real clause boundaries.
    for a, b in zip(boundaries, boundaries[1:]):
        if size(a, b) == 0:
            if text[a:b].strip() in ('“', '"', "‘", "(", "[") and b < len(text):
                normalized.discard(b)
            elif a:
                normalized.discard(a)
    return sorted(normalized)


def analyze(nlp, texts):
    if "reading_era_sentences" not in nlp.pipe_names:
        nlp.add_pipe("reading_era_sentences", before="parser")
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

        sentences = [span(s.start_char, s.end_char) for s in doc.sents]
        boundaries = reading_cuts(doc, chains)
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
