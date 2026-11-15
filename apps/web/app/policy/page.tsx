'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, ErrorNote, Panel, cx, inputCls } from '@/components/ui';
import { api } from '@/lib/api';
import { useGate } from '@/lib/events';

type Obj = Record<string, unknown>;
interface ToolRule { tier?: string; targetArgs?: string[] | '*' }
const TIERS = ['view', 'lookup-infra', 'lookup-person', 'active-probe', 'publish'];
const TIER_HELP: Record<string, string> = {
  view: 'no external effect: always allowed',
  'lookup-infra': 'passive lookup on a host or domain',
  'lookup-person': 'profiles a natural person',
  'active-probe': 'touches a target system: authorised hosts only',
  publish: 'others rely on it: always asks a human',
};
const TRIGGERS: { key: string; label: string; help: string; def: string }[] = [
  { key: 'onUnknown', label: 'Untraceable target, sensitive tool', help: 'The model produced a value seen in no recorded text (paraphrased, decoded, invented).', def: 'require_approval' },
  { key: 'onTaintedSensitive', label: 'Target from untrusted text, sensitive tool', help: 'Person lookup, probe or publish whose target appears only in feed/tool output.', def: 'deny' },
  { key: 'onTaintedInfra', label: 'Target from untrusted text, passive infra lookup', help: 'For example a WHOIS on a domain a headline mentioned.', def: 'require_approval' },
  { key: 'onUnknownInfra', label: 'Untraceable target, passive infra lookup', help: 'Set to "ask a human" for strict mode.', def: 'allow' },
];
const VERDICT_LABEL: Record<string, string> = { allow: 'allow', require_approval: 'ask a human', deny: 'block' };

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export default function PolicyPage() {
  const { policyTick, connected } = useGate();
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [file, setFile] = useState('');
  const [check, setCheck] = useState<{ state: 'idle' | 'checking' | 'valid' | 'invalid'; error?: string }>({ state: 'idle' });
  const [note, setNote] = useState<{ ok: boolean; msg: string } | null>(null);
  const [newHost, setNewHost] = useState('');
  const loaded = useRef(false);

  useEffect(() => {
    if (!connected) return;
    api<{ policy: Obj; file: string }>('/api/policy').then(r => {
      const t = JSON.stringify(r.policy, null, 2);
      setSaved(t);
      setFile(r.file);
      // Do not overwrite edits in progress when someone else saves.
      if (!loaded.current) {
        setText(t);
        loaded.current = true;
      }
    }, e => setNote({ ok: false, msg: (e as Error).message }));
  }, [policyTick, connected]);

  const parsed = useMemo<{ obj: Obj | null; error?: string }>(() => {
    if (!text.trim()) return { obj: null, error: 'empty' };
    try {
      const v: unknown = JSON.parse(text);
      return isObj(v) ? { obj: v } : { obj: null, error: 'Top level must be a JSON object' };
    } catch (e) {
      return { obj: null, error: `Not valid JSON: ${(e as Error).message}` };
    }
  }, [text]);

  // Instant feedback from the same strict validator the gate uses.
  useEffect(() => {
    if (!parsed.obj) return setCheck(parsed.error === 'empty' ? { state: 'idle' } : { state: 'invalid', error: parsed.error });
    setCheck(c => ({ ...c, state: 'checking' }));
    const t = setTimeout(() => {
      api<{ valid: boolean; error?: string }>('/api/policy/validate', { method: 'POST', body: parsed.obj }).then(
        r => setCheck(r.valid ? { state: 'valid' } : { state: 'invalid', error: r.error }),
        e => setCheck({ state: 'invalid', error: (e as Error).message }),
      );
    }, 250);
    return () => clearTimeout(t);
  }, [parsed]);

  const p = parsed.obj;
  const update = (fn: (draft: Obj) => void) => {
    if (!p) return;
    const draft = JSON.parse(JSON.stringify(p)) as Obj;
    fn(draft);
    setText(JSON.stringify(draft, null, 2));
    setNote(null);
  };
  const tools = isObj(p?.tools) ? (p!.tools as Record<string, ToolRule>) : {};
  const setTools = (fn: (entries: [string, ToolRule][]) => [string, ToolRule][]) => update(d => { d.tools = Object.fromEntries(fn(Object.entries(isObj(d.tools) ? (d.tools as Record<string, ToolRule>) : {}))); });
  const hosts = strs(p?.authorisedTargets);
  const dirty = text !== saved;

  const save = async () => {
    if (!p) return;
    try {
      const r = await api<{ policy: Obj }>('/api/policy', { method: 'PUT', body: p });
      const t = JSON.stringify(r.policy, null, 2);
      setSaved(t);
      setText(t);
      setNote({ ok: true, msg: 'Saved. New sessions use this policy.' });
    } catch (e) {
      setNote({ ok: false, msg: (e as Error).message });
    }
  };
  const addHost = () => {
    const h = newHost.trim().toLowerCase();
    if (h && !hosts.includes(h)) update(d => { d.authorisedTargets = [...strs(d.authorisedTargets), h]; });
    setNewHost('');
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Strict JSON policy editor</h1>
          <p className="max-w-3xl text-xs text-muted">The policy is written by the operator and never shown to the model. Validation is strict: an unknown key or tier is an error, never a silently weaker policy.</p>
        </div>
        <div className="flex items-center gap-2">
          {check.state === 'valid' && <Badge tone="green">valid</Badge>}
          {check.state === 'checking' && <Badge>checking…</Badge>}
          {check.state === 'invalid' && <Badge tone="red">invalid</Badge>}
          {dirty && <Badge tone="amber">unsaved changes</Badge>}
          <Button disabled={!dirty} onClick={() => { setText(saved); setNote(null); }}>Revert</Button>
          <Button tone="cyan" disabled={!dirty || check.state !== 'valid'} onClick={save}>Save policy</Button>
        </div>
      </div>
      {check.state === 'invalid' && <div className="mb-3"><ErrorNote>{check.error}</ErrorNote></div>}
      {note && <p role="status" className={cx('mb-3 rounded-md border px-3 py-2 text-xs', note.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : 'border-rose-500/40 bg-rose-500/10 text-rose-200')}>{note.msg}</p>}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,460px)]">
        <fieldset disabled={!p} className={cx('min-w-0 space-y-4', !p && 'opacity-50')}>
          <Panel title="Allowed hosts for active probes">
            <div className="p-3">
              <p className="mb-2 text-xs text-muted">Hosts you own or are authorised to test. A probe of anything else is blocked outright, whoever asked. Subdomains are included.</p>
              <div className="flex flex-wrap gap-1.5">
                {hosts.map(h => (
                  <span key={h} className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 font-mono text-xs text-emerald-200">
                    {h}
                    <button aria-label={`Remove ${h}`} className="text-emerald-300/70 hover:text-rose-300" onClick={() => update(d => { d.authorisedTargets = strs(d.authorisedTargets).filter(x => x !== h); })}>✕</button>
                  </span>
                ))}
                {hosts.length === 0 && <span className="text-xs text-amber-300">None: every active probe is blocked.</span>}
              </div>
              <form className="mt-2 flex gap-2" onSubmit={e => { e.preventDefault(); addHost(); }}>
                <input aria-label="Host to authorise" className={cx(inputCls, 'font-mono')} placeholder="lab.example.org" value={newHost} onChange={e => setNewHost(e.target.value)} />
                <Button type="submit">Add host</Button>
              </form>
            </div>
          </Panel>

          <Panel title="Tool rules" right={<button className="text-[11px] text-cyan-300 hover:underline" onClick={() => setTools(es => [...es, [`new_tool_${es.length + 1}`, { tier: 'lookup-person', targetArgs: '*' }]])}>+ add tool</button>}>
            <div className="overflow-x-auto p-3">
              <table className="w-full min-w-[560px] text-xs">
                <thead className="text-left text-[10.5px] uppercase tracking-wider text-muted">
                  <tr><th className="pb-1.5 font-medium">Tool name</th><th className="pb-1.5 font-medium">Risk tier</th><th className="pb-1.5 font-medium">Traced arguments</th><th /></tr>
                </thead>
                <tbody>
                  {Object.entries(tools).map(([name, rule], i) => {
                    const all = rule.targetArgs === '*' || (rule.targetArgs === undefined && rule.tier !== 'view');
                    return (
                      <tr key={i} className="align-top">
                        <td className="py-1 pr-2"><input aria-label="Tool name" className={cx(inputCls, 'font-mono')} value={name} onChange={e => setTools(es => es.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} /></td>
                        <td className="py-1 pr-2">
                          <select aria-label={`Tier for ${name}`} className={inputCls} value={rule.tier ?? ''} title={TIER_HELP[rule.tier ?? '']} onChange={e => setTools(es => es.map((x, j) => (j === i ? [x[0], { ...x[1], tier: e.target.value }] : x)))}>
                            {!TIERS.includes(rule.tier ?? '') && <option value={rule.tier ?? ''}>{rule.tier ?? '(none)'}</option>}
                            {TIERS.map(t => <option key={t}>{t}</option>)}
                          </select>
                          <div className="mt-0.5 text-[10.5px] text-slate-500">{TIER_HELP[rule.tier ?? ''] ?? 'unknown tier'}</div>
                        </td>
                        <td className="py-1 pr-2">
                          {rule.tier === 'view' ? <span className="inline-block py-1.5 text-slate-600">not traced</span> : (
                            <div className="flex items-center gap-2">
                              <label className="flex shrink-0 items-center gap-1 text-muted"><input type="checkbox" checked={all} onChange={e => setTools(es => es.map((x, j) => (j === i ? [x[0], { ...x[1], targetArgs: e.target.checked ? '*' : [] }] : x)))} /> all</label>
                              {!all && <input aria-label={`Arguments traced for ${name}`} className={cx(inputCls, 'font-mono')} placeholder="handle, email" value={strs(rule.targetArgs).join(', ')} onChange={e => setTools(es => es.map((x, j) => (j === i ? [x[0], { ...x[1], targetArgs: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }] : x)))} />}
                            </div>
                          )}
                        </td>
                        <td className="py-1"><button aria-label={`Remove ${name}`} className="px-1 py-1.5 text-muted hover:text-rose-300" onClick={() => setTools(es => es.filter((_, j) => j !== i))}>✕</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <label className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-xs text-muted">
                Tools not listed above:
                <select className={cx(inputCls, '!w-auto')} value={isObj(p?.defaultTool) ? String((p!.defaultTool as ToolRule).tier) : ''} onChange={e => update(d => { if (e.target.value) d.defaultTool = { tier: e.target.value, targetArgs: '*' }; else delete d.defaultTool; })}>
                  <option value="">block (default)</option>
                  {TIERS.filter(t => t !== 'view').map(t => <option key={t} value={t}>treat as {t}, trace every argument</option>)}
                </select>
              </label>
            </div>
          </Panel>

          <Panel title="Elicitation triggers: when to ask a human">
            <ul className="divide-y divide-line">
              {TRIGGERS.map(t => (
                <li key={t.key} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px]">{t.label}</div>
                    <div className="text-[11px] text-muted">{t.help}</div>
                  </div>
                  <select aria-label={t.label} className={cx(inputCls, '!w-52')} value={typeof p?.[t.key] === 'string' ? (p![t.key] as string) : ''} onChange={e => update(d => { if (e.target.value) d[t.key] = e.target.value; else delete d[t.key]; })}>
                    <option value="">default ({VERDICT_LABEL[t.def]})</option>
                    {Object.entries(VERDICT_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Operator-vouched text">
            <div className="p-3">
              <p className="mb-2 text-xs text-muted">One statement per line. Values that appear here count as typed by the operator in every session (standing tasking).</p>
              <textarea aria-label="Trusted statements" className={inputCls} rows={3} dir="auto" value={strs(p?.trusted).join('\n')} onChange={e => update(d => { d.trusted = e.target.value.split('\n').filter(l => l.trim()); })} placeholder="Standing task: monitor example.org" />
            </div>
          </Panel>
        </fieldset>

        <Panel title="Live JSON" className="xl:sticky xl:top-6 xl:self-start" right={<span className="max-w-[240px] truncate font-mono text-[10.5px] text-slate-500" title={file}>{file}</span>}>
          <div className="p-3">
            <textarea aria-label="Policy JSON" spellCheck={false} className={cx(inputCls, 'min-h-[560px] font-mono !text-xs leading-relaxed', check.state === 'invalid' && '!border-rose-500/60')} value={text} onChange={e => { setText(e.target.value); setNote(null); }} />
            <p className="mt-1.5 text-[11px] text-slate-500">Edit either side: the form and the JSON stay in sync. Nothing is saved until it validates.</p>
          </div>
        </Panel>
      </div>
    </>
  );
}
