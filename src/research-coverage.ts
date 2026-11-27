// Keep the user's wording and ordering stable across source batches and the repair turn.
export function researchQuestions(input: string) {
  const request = input.replace(/https?:\/\/[^\s\u3000-\u303f\u3400-\u9fff\uff00-\uffef]+|\b(?:local|gamma):\d+\b/gi, '').trim();
  const clauses = request.split(/[？?！!。；;\n]+|[，、,]\s*(?=(?:谁|几[点比分]|在哪|哪[天里个]|什么时|是否|有没有|实际|后来|相差|分别|为什么|怎么|又有|还有哪些|对.{1,10}有.{0,5}影响))/u)
    .map(s => s.trim()).filter(s => s && !/^(?:请|麻烦)?(?:简短点|简单点|简单说说|简明回答|用中文回答|三句话(?:就好|就行|即可)?|不用展开|不要表格|不要长篇大论)$/.test(s));
  return [...new Set(clauses.length ? clauses : [request || input])];
}

export type ResearchFact = { text: string; proofs: { id: string; quote: string }[]; anchor?: true };
export type ResearchParagraph = { text: string; basis: number[] };
export type QuestionCoverage = { question: string; factNumbers: number[]; evidenceIds: string[]; excerpt: string; gap: string };

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function onlyPregameProof(proofs: ResearchFact['proofs'], document: (id: string) => string | undefined) {
  return proofs.length > 0 && proofs.every(p =>
    /^(?:nba_injury_report|nba_schedule|fixture_schedule|market_definition)$/.test(document(p.id) ?? '') ||
    /\b(?:questionable|game-time decision|available to play|cleared to play|expected to play)\b/i.test(p.quote) &&
    !/\b(?:played \d|scored|did not play|sat out|logged \d)\b/i.test(p.quote));
}

export function checkQuestionCoverage(questions: string[], facts: ResearchFact[], paragraphs: ResearchParagraph[],
  verdict: unknown, document: (id: string) => string | undefined): QuestionCoverage[] {
  const rows: unknown[] = record(verdict) && Array.isArray(verdict.items) ? verdict.items : [];
  return questions.map((question, i) => {
    const matches = rows.filter(r => record(r) && r.item === i + 1);
    const row = matches.length === 1 && record(matches[0]) ? matches[0] : undefined;
    const basis = row?.facts;
    const valid = Array.isArray(basis) && basis.length > 0 &&
      basis.every((n): n is number => Number.isInteger(n) && n >= 1 && n <= facts.length && !!facts[n - 1].proofs.length);
    const factNumbers: number[] = valid ? [...new Set(basis)] : [];
    const proofs = factNumbers.flatMap(n => facts[n - 1].proofs);
    const asksPlayed = /(?:有没有|是否|实际|到底|最终|最后).{0,5}(?:上场|出场|登场)|(?:上场|出场|登场)了(?:没|吗)/.test(question);
    const supported = valid && row?.complete === true && !(asksPlayed && onlyPregameProof(proofs, document));
    const excerpt = supported && typeof row?.excerpt === 'string' ? row.excerpt.trim() : '';
    const visible = paragraphs.some(p => /[\p{L}\p{N}]/u.test(excerpt) && p.text.includes(excerpt) &&
      p.basis.some(n => factNumbers.includes(n))) && factNumbers.every(n => paragraphs.some(p => p.basis.includes(n)));
    let gap = '';
    if (!supported) {
      gap = typeof row?.gap === 'string' && /^尚未/.test(row.gap) && row.gap.length <= 130 &&
        !/https?:|[\x60*#]|证据\s*ID/i.test(row.gap) ? row.gap : '尚未核实「' + question + '」。';
    }
    return { question, factNumbers: supported ? factNumbers : [], evidenceIds: supported ? [...new Set(proofs.map(p => p.id))] : [],
      excerpt: visible ? excerpt : '', gap };
  });
}
