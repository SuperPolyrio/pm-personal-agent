import { sourceSetting } from './source-config.js';
type SourceBook = { book: string; url: string; displayedTime: string; publisher?: 'CS2Odds' | 'Sir Betalot'; outcomes: { name: string; decimal: number }[] };
type Save = (source: string, data: unknown, retrievedAt: string) => { evidenceId: string };

async function readHtml(url: string, signal: AbortSignal) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

export async function readNbaOddsReference(slug: string, teams: string[], kickoff: string, save: Save,
                                           signal: AbortSignal): Promise<(SourceBook & { evidenceId: string })[]> {
  const configured = process.env.PM_NBA_ODDS_REFERENCE_EVENTS;
  if (!configured) return [];
  let url: string | undefined;
  try { url = (JSON.parse(configured) as Record<string, string>)[slug]; }
  catch { return []; }
  const page = typeof url === 'string' ? URL.parse(url) : null;
  if (!url || !page || page.origin !== sourceSetting('PM_LUNOSPORT_URL') || page.username || page.password ||
      page.search || page.hash || !/^\/nba\/\d{4}-\d{2}-\d{2}\/[a-z\d-]+-\d+$/.test(page.pathname)) return [];

  try {
    const eventHtml = await readHtml(url, signal);
    const event = [...eventHtml.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)]
      .map(match => JSON.parse(match[1])).find(value => value['@type'] === 'SportsEvent');
    const names = [event?.awayTeam?.name, event?.homeTeam?.name];
    if (event?.url !== url || event.sport !== 'Basketball' || Date.parse(event.startDate) !== Date.parse(kickoff)
        || teams.length !== 2 || !teams.every(team => names.some(name => typeof name === 'string' &&
          (name.toLowerCase() === team.toLowerCase() || name.toLowerCase().endsWith(` ${team.toLowerCase()}`))))) return [];

    const books = await Promise.allSettled([['DraftKings', 'draftkings'], ['bet365', 'bet365']].map(async ([book, key]) => {
      const page = `${url}/odds/${key}`;
      const html = await readHtml(page, signal);
      if (!html.includes(`<link rel="canonical" href="${page}"`)) return;
      const table = html.match(/<div class="card lmcard" id="money">[\s\S]*?<table[^>]*>([\s\S]*?)<\/table>/)?.[1] ?? '';
      const head = [...table.matchAll(/<th[^>]*>([A-Z]+)<\/th>/g)].map(match => match[1]);
      const badges = [...html.matchAll(/<div class="pbpteam">\s*<span class="glogo">([A-Z]+)<picture>/g)].map(match => match[1]);
      if (head.length !== 2 || badges.join(',') !== head.join(',')) return;
      const row = table.match(/<tbody>\s*<tr>([\s\S]*?)<\/tr>/)?.[1] ?? '';
      const displayedTime = row.match(/<td class="l">([^<]+)<\/td>/)?.[1]?.trim();
      const prices = [...row.matchAll(/<span class="opa">(&#x2B;|-)(\d+)<\/span>/g)].map(([, sign, raw]) => {
        const value = Number(raw);
        return value >= 100 && Number.isSafeInteger(value) ? 1 + (sign === '-' ? 100 / value : value / 100) : NaN;
      });
      if (!displayedTime || prices.length !== 2 || !prices.every(Number.isFinite)) return;
      return { quote: { book, url: page, displayedTime, outcomes: names.map((name, index) => ({ name, decimal: prices[index] })) } satisfies SourceBook,
        sourceRow: row, sourceHeadings: head };
    }));
    signal.throwIfAborted();
    const available = books.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
    if (!available.length) return [];
    const receivedAt = new Date().toISOString();
    return available.map(({ quote, sourceRow, sourceHeadings }) => ({ ...quote,
      evidenceId: save(quote.url, { kind: 'public_historical_odds', event, ...quote, sourceRow, sourceHeadings }, receivedAt).evidenceId }));
  } catch {
    signal.throwIfAborted();
    return [];
  }
}

const cs2Odds = sourceSetting('PM_CS2_ODDS_URL');
const compactName = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const teamName = (value: string) => compactName(value.replace(/^team\s+/i, ''));

function sameTeam(left: string, right: string) {
  const initials = (value: string) => value.trim().split(/\s+/).map(word => word[0] ?? '').join('').toLowerCase();
  return teamName(left) === teamName(right)
    || /^[A-Z0-9]{3,5}$/.test(left) && compactName(left) === initials(right)
    || /^[A-Z0-9]{3,5}$/.test(right) && compactName(right) === initials(left);
}

function pagePayload(html: string) {
  return [...html.matchAll(/<script>self\.__next_f\.push\((.*?)\)<\/script>/gs)].map(match => JSON.parse(match[1]))
    .filter(([channel]) => channel === 1).map(([, body]) => body).join('');
}

function jsonObjectAt<T>(text: string, start: number): T | undefined {
  if (text[start] !== '{') return;
  // The publisher serializes JSON alongside page content. Read a single
  // object and ignore braces inside JSON strings.
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}]/g;
  tokens.lastIndex = start;
  let depth = 0;
  for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
    if (token[0] === '{') depth++;
    else if (token[0] === '}' && --depth === 0) return JSON.parse(text.slice(start, tokens.lastIndex)) as T;
  }
}

type Cs2Match = { id: string; slug: string; scheduledStartAt: string; teamA: { name: string }; teamB: { name: string };
  bestOf: number; tournamentName: string };
type Cs2Quote = { bookmakerBrandId: string; bookmakerMarketId: string; bookmakerName: string; selectionId: string;
  decimalOdds: number; observedAt: string; lastActiveVerifiedAt?: string };
type Cs2Selection = { selectionId: string; label: string; quotes: Cs2Quote[] };
type Cs2Winner = { marketType: string; mapNumber: number | null; lines: { line: number | null; selections: Cs2Selection[] }[] };

export async function readCs2OddsReference(input: { teams: string[][]; kickoff: string; bestOf: number | null | undefined;
  tournament: string; existingBooks: string[] }, save: Save, signal: AbortSignal) {
  const kickoff = Date.parse(input.kickoff);
  if (!Number.isFinite(kickoff)) return [];
  const isPair = (a: string, b: string) => input.teams.some(pair => pair.length === 2 &&
    (sameTeam(pair[0], a) && sameTeam(pair[1], b) || sameTeam(pair[0], b) && sameTeam(pair[1], a)));
  try {
    const index = pagePayload(await readHtml(cs2Odds + '/', signal));
    const matches = new Map<string, Cs2Match>();
    for (const hit of index.matchAll(/\{"id":"[^"]+","slug":"[a-z0-9-]+","scheduledStartAt":"([^"]+)"/g)) {
      const delta = Math.abs(Date.parse(hit[1]) - kickoff);
      if (!(delta <= 30 * 60_000)) continue;
      const item = jsonObjectAt<Cs2Match>(index, hit.index);
      if (!item?.teamA?.name || !item.teamB?.name || !isPair(item.teamA.name, item.teamB.name)
          || input.bestOf && item.bestOf !== input.bestOf) continue;
      if (delta > 5 * 60_000) {
        const tournament = compactName(input.tournament.replace(/\bstage\s+\d+\b/i, ''));
        if (tournament.length < 8 || !compactName(item.tournamentName).includes(tournament)) continue;
      }
      matches.set(item.slug, item);
    }
    if (matches.size !== 1) return [];
    const item = [...matches.values()][0];
    if (!/^[a-z0-9-]{1,200}$/.test(item.slug)) return [];
    const url = `${cs2Odds}/matches/${item.slug}`;
    const html = await readHtml(url, signal);
    const schema = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs)]
      .flatMap(match => JSON.parse(match[1])['@graph'] ?? []).find(row => row['@type'] === 'SportsEvent');
    const names = schema?.competitor?.map((team: { name: string }) => team.name);
    if (schema?.url !== url || schema.sport !== 'Counter-Strike 2' || Date.parse(schema.startDate) !== Date.parse(item.scheduledStartAt)
        || names?.length !== 2 || !isPair(names[0], names[1])) return [];
    const payload = pagePayload(html);
    const marker = '"marketType":"match_winner"';
    const position = payload.indexOf(marker);
    if (position === -1 || payload.indexOf(marker, position + marker.length) !== -1) return [];
    const market = jsonObjectAt<Cs2Winner>(payload, payload.lastIndexOf('{"familyId":', position));
    const line = market?.lines[0];
    const selections = line?.selections;
    if (market?.marketType !== 'match_winner' || market.mapNumber !== null || market.lines.length !== 1
        || line?.line !== null || selections?.length !== 2 || !isPair(selections[0].label, selections[1].label)) return [];

    const receivedAt = new Date().toISOString();
    const closing = Math.min(kickoff, Date.parse(item.scheduledStartAt), Date.parse(receivedAt));
    const existing = new Set(input.existingBooks.map(compactName));
    const valid = (quote: Cs2Quote, selection: Cs2Selection) => quote.selectionId === selection.selectionId
      && quote.bookmakerBrandId && quote.bookmakerMarketId && quote.bookmakerName && Number.isFinite(quote.decimalOdds)
      && quote.decimalOdds > 1 && Date.parse(quote.observedAt) <= closing;
    const [left, right] = selections;
    const other = new Map(right.quotes.filter(q => valid(q, right)).map(q => [q.bookmakerMarketId, q]));
    return left.quotes.flatMap(first => {
      const second = other.get(first.bookmakerMarketId);
      const book = compactName(first.bookmakerName ?? '');
      if (!valid(first, left) || !second || first.bookmakerBrandId !== second.bookmakerBrandId || existing.has(book)) return [];
      existing.add(book);
      const outcomes = [first, second].map((quote, i) => ({ name: selections[i].label, decimal: quote.decimalOdds }));
      const displayedTime = new Date(Math.min(Date.parse(first.observedAt), Date.parse(second.observedAt))).toISOString();
      const quote: SourceBook = { book: first.bookmakerName, url, publisher: 'CS2Odds', displayedTime, outcomes };
      const evidence = save(url, { kind: 'public_prematch_odds', fixture: { id: item.id, teams: names,
        kickoff: item.scheduledStartAt, bestOf: item.bestOf, tournament: item.tournamentName },
      type: market.marketType, bookmakerMarketId: first.bookmakerMarketId, bookmakerBrandId: first.bookmakerBrandId,
      ...quote, sourceClocks: [first, second].map(({ selectionId, observedAt, lastActiveVerifiedAt }) =>
        ({ selectionId, observedAt, lastActiveVerifiedAt })) }, receivedAt);
      return [{ ...quote, evidenceId: evidence.evidenceId }];
    });
  } catch {
    signal.throwIfAborted();
    return [];
  }
}
