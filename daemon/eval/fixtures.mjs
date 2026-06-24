// Checked-in fixtures for the quality harness (#6). Synthetic + tiny so the eval is fast,
// deterministic, and ships in-repo. Replace/extend with opt-in, scrubbed real captures over time.

// OCR fidelity: [reference, ocr-output] pairs → CER/WER. (small, deliberate error)
export const OCR_PAIRS = [
  ['the quick brown fox jumps over the lazy dog', 'the quick brown fox jumps over the lazy dog'],
  ['implementing the segmentation state machine with simhash dedup', 'implementing the segmentation state machine with simhash dedup'],
  ['neo4j temporal knowledge graph bi-temporal edges vector index', 'neo4j temporal knowledge graph bitemporal edges vector index'],
];

// Segmentation: an event stream with a single intended topic boundary (graph work → break).
// boundaries = event indices where a NEW episode should start.
export const SEG_FIXTURE = {
  events: [
    { t: 0,    source: 'ocr', app: 'Code', window_id: 'Code|graph', text: 'graph database neo4j cypher queries vector index setup' },
    { t: 1000, source: 'ocr', app: 'Code', window_id: 'Code|graph', text: 'neo4j bolt connection knowledge graph store vector index query' },
    { t: 2000, source: 'ocr', app: 'Code', window_id: 'Code|graph', text: 'lunch coffee break walk around campus weather sunny afternoon' },
  ],
  boundaries: [2],
};

// Grounding / hallucination: a labeled claim must be a substring of its source (no fabrication).
export const GROUNDING_CASES = [
  { source: 'X Home ... thanks for the support! ... Trending now ...', claim: 'thanks for the support!' }, // grounded
  { source: 'reading the neo4j docs on temporal graphs', claim: '' },                                       // empty = trivially grounded
  { source: 'the actual on-screen text here', claim: 'a sentence the model invented' },                     // HALLUCINATION
];

// End-to-end retrieval: a short work session + queries with an expected top hit (regex on text).
export const QA_FIXTURE = {
  now: 9_000_000,
  events: [
    ['Mail', 'Mail|draft', 'composing an email to the design team about the pitch deck timeline and the demo flow'],
    ['Mail', 'Mail|draft', 'email to the design team: lets finalize the pitch deck visuals before friday review'],
    ['Browser', 'Browser|neo4j', 'reading neo4j documentation about temporal graph indexes and cypher queries'],
    ['Browser', 'Browser|neo4j', 'neo4j vector index setup and bolt connection for the knowledge graph store'],
    ['Code', 'Code|seg', 'implementing the segmentation state machine with simhash dedup and idle boundaries'],
  ].map(([app, window_id, text], i) => ({ t: i * 60_000, source: 'ocr', app, window_id, text })),
  queries: [
    { q: 'what was I emailing the design team about?', expect: /design team|pitch deck/i },
    { q: 'what neo4j documentation was I reading?', expect: /neo4j/i },
  ],
};
