# MCP gate proxy

`admiralty-gate mcp-proxy` sits between an MCP client (the application that hosts the model) and an MCP server (the thing with the tools). Neither is modified.

```
MCP client ──stdio──► admiralty-gate mcp-proxy ──stdio──► real MCP server
```

## Set-up

1. Write a policy (start from `examples/policy.example.json`). List each tool the server exposes with a tier:

   | Tier | Meaning | Default handling |
   |---|---|---|
   | `view` | no external effect | always allowed |
   | `lookup-infra` | passive lookups on hosts, domains, IPs | operator-typed: allow. From server output: approval. Untraceable: allow (`onUnknownInfra` to change) |
   | `lookup-person` | profiles a natural person | operator-vouched: allow. From server output: **deny**. Untraceable: approval |
   | `active-probe` | touches a target system | denied unless the host is in `authorisedTargets`, then as above |
   | `publish` | others will rely on it | always approval |

   Tools you do not list are denied, unless you set `defaultTool`. `"targetArgs": "*"` traces every argument and is the right choice for a server you do not control.

2. In the client's MCP configuration, replace the server command with the proxy:

   ```json
   {
     "command": "npx",
     "args": ["admiralty-gate", "mcp-proxy", "--policy", "/path/policy.json", "--audit", "/path/audit.jsonl", "--", "npx", "the-real-server"]
   }
   ```

3. Optional: `--operator-file /path/operator.txt`. Each line of that file is trusted operator text, re-read before every decision. `echo "bob_77" >> operator.txt` from your own terminal authorises that value for the rest of the session. The file must not be writable by the agent or any of its tools.

## Trust model

The proxy never sees what the user typed into the client. It therefore knows three kinds of value:

- **trusted**: appears in the policy's `trusted` list or the operator file;
- **tainted**: appears in something the server returned (tool results, tool descriptions, resources, prompts, sampling requests), all of which are recorded before the client's model reads them;
- **unknown**: appears in neither. This is where a value the user typed in the chat ends up, and also where a value the model invented ends up. The proxy cannot tell these apart, which is why `unknown` on a sensitive tier asks a human.

`require_approval` is sent to the human as an MCP `elicitation/create` request built by the proxy, showing the tool, each argument (cleaned of invisible characters, quoted, truncated) and where it came from. Only `action: "accept"` with `approve: true` runs the call. A decline, a cancel, an error, a timeout (5 minutes), a closed connection, or a client without elicitation support all mean no.

With the default policy a tainted target for a person lookup is denied outright. If your analysts legitimately say "look up the handle in that post", set `"onTaintedSensitive": "require_approval"` so the human is asked instead. Do that only with a client that really shows elicitation prompts to a person.

## What it does not do

- It does not filter or rewrite server output. Poisoned text still reaches the model; it just cannot authorise a gated call.
- It does not gate tools that live outside this server (other MCP servers, the client's built-in tools). Put each server you care about behind its own proxy. Provenance is per proxy, so text returned by server A is not known to the proxy in front of server B: there, an injected value is `unknown`, which needs approval on sensitive tiers and is allowed on passive infra lookups unless `onUnknownInfra` is set.
- Stdio transport only. Streamable HTTP is on the roadmap.
- JSON-RPC batches are processed message by message.
- Tracing is lexical (whole-token). A target the model decoded from base64 is `unknown`, not `tainted`.

## Audit

`--audit file.jsonl` appends every decision and approval to a SHA-256 hash chain. `admiralty-gate verify-audit file.jsonl` checks it and prints the head hash; store that hash somewhere the agent host cannot write if you need to detect truncation of the tail.
