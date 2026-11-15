/**
 * The sandbox's tools are SIMULATED. Nothing here touches the network, looks anyone up or scans anything: each tool
 * returns canned text. The point of the sandbox is to watch the gate, not to do OSINT.
 */
export const DEFAULT_POLICY = {
  $comment:
    'Sandbox policy. Edited by the operator in the dashboard; the model never sees it. find_username lists one target argument on purpose, so the "unlisted argument" scenario has something to show.',
  authorisedTargets: ['lab.example.org'],
  trusted: [],
  tools: {
    search_news: { tier: 'view' },
    whois: { tier: 'lookup-infra', targetArgs: ['domain'] },
    find_username: { tier: 'lookup-person', targetArgs: ['handle'] },
    port_scan: { tier: 'active-probe', targetArgs: ['host'] },
    send_alert: { tier: 'publish', targetArgs: '*' },
    // OSIRIS collection and fusion tools, under both spellings. Fetching is an infrastructure lookup whose target
    // must come from the operator. geo-enrich and entity-graph can locate or profile a person, so they sit in the
    // person tier with every argument traced: a target that arrived in feed text is refused.
    'osint-fetch': { tier: 'lookup-infra', targetArgs: ['url', 'source', 'channel', 'feed', 'query', 'target'] },
    osint_fetch: { tier: 'lookup-infra', targetArgs: ['url', 'source', 'channel', 'feed', 'query', 'target'] },
    'geo-enrich': { tier: 'lookup-person', targetArgs: '*' },
    geo_enrich: { tier: 'lookup-person', targetArgs: '*' },
    'entity-graph': { tier: 'lookup-person', targetArgs: '*' },
    entity_graph: { tier: 'lookup-person', targetArgs: '*' },
  },
};

export const DEFAULT_FEED = 'Limassol port strike enters its second day; 14 vessels wait at anchor. Union talks resume on Thursday.';

export interface ToolDef {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

export const TOOL_DEFS: ToolDef[] = [
  { name: 'search_news', description: 'Search the news feed. Returns headlines and snippets written by third parties.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search terms' } }, required: ['query'] } },
  { name: 'whois', description: 'Passive WHOIS lookup for a domain.', parameters: { type: 'object', properties: { domain: { type: 'string', description: 'Domain name' } }, required: ['domain'] } },
  { name: 'find_username', description: 'Find accounts that use a given username across public sites.', parameters: { type: 'object', properties: { handle: { type: 'string', description: 'The username' } }, required: ['handle'] } },
  { name: 'port_scan', description: 'Actively scan a host for open ports.', parameters: { type: 'object', properties: { host: { type: 'string', description: 'Hostname or IP' } }, required: ['host'] } },
  { name: 'osint-fetch', description: 'Fetch a public OSINT feed or page by URL.', parameters: { type: 'object', properties: { url: { type: 'string', description: 'Feed or page URL' } }, required: ['url'] } },
  { name: 'geo-enrich', description: 'Geolocate an IP address, host or place name.', parameters: { type: 'object', properties: { target: { type: 'string', description: 'IP, host or place' } }, required: ['target'] } },
  { name: 'entity-graph', description: 'Build a graph of entities linked to a seed identifier.', parameters: { type: 'object', properties: { seed: { type: 'string', description: 'Domain, wallet, handle or address to start from' } }, required: ['seed'] } },
  { name: 'send_alert', description: 'Send an alert to the on-call team.', parameters: { type: 'object', properties: { text: { type: 'string', description: 'Alert text' } }, required: ['text'] } },
];

const show = (v: unknown): string => JSON.stringify(v);

export function simulatedTool(feed: string): (call: { tool: string; args: Record<string, unknown> }) => Promise<string> {
  return async ({ tool, args }) => {
    switch (tool) {
      case 'search_news':
        return feed || DEFAULT_FEED;
      case 'whois':
        return `[simulated] WHOIS ${show(args.domain)}: registrar Example Registrar Ltd, created 2019-03-02.`;
      case 'find_username':
        return `[simulated] Username hunt ${show(args)}: 3 matching accounts. No real lookup was performed.`;
      case 'port_scan':
        return `[simulated] Scan ${show(args.host)}: 22/tcp open, 443/tcp open. No packets were sent.`;
      case 'osint-fetch':
      case 'osint_fetch':
        return `[simulated] Fetched ${show(args.url ?? args.source ?? args)}: 3 items. Nothing was requested from the network.`;
      case 'geo-enrich':
      case 'geo_enrich':
        return `[simulated] ${show(args)} resolves to 34.68, 33.04 (Limassol). No lookup was performed.`;
      case 'entity-graph':
      case 'entity_graph':
        return `[simulated] Entity graph for ${show(args)}: 4 nodes, 5 edges. No lookup was performed.`;
      case 'send_alert':
        return '[simulated] Alert queued. Nothing was sent.';
      default:
        return `[simulated] ${tool} ${show(args)} ran.`;
    }
  };
}
