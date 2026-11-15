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
      case 'send_alert':
        return '[simulated] Alert queued. Nothing was sent.';
      default:
        return `[simulated] ${tool} ${show(args)} ran.`;
    }
  };
}
