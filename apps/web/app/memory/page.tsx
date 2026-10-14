"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Brain, FilePlus2, History, Save, Trash2, Undo2, Wand2 } from "lucide-react";
import { Shell } from "@/components/Shell";
import { BotAvatar, Button, Card, Empty, Input, Modal, PageHeader, Select, Spinner, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { useCrew, useCrewEvent } from "@/lib/store";
import { cx, dateTime, timeAgo } from "@/lib/format";

interface MemFile {
  path: string;
  scope: "shared" | "bot" | "skill";
  botId: string | null;
  name: string;
  size: number;
  updatedAt: string;
}

interface MemEvent {
  id: string;
  ts: string;
  bot_id: string | null;
  actor: string;
  path: string;
  action: string;
  before?: string | null;
  after?: string | null;
  preview?: string;
}

function MemoryPage() {
  const crew = useCrew();
  const [files, setFiles] = useState<MemFile[] | null>(null);
  const [skills, setSkills] = useState<MemFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [history, setHistory] = useState<MemEvent[]>([]);
  const [recent, setRecent] = useState<MemEvent[]>([]);
  const [creating, setCreating] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async () => {
    const r = await api.get<{ files: MemFile[]; skills: MemFile[] }>("/api/memory");
    setFiles(r.files);
    setSkills(r.skills);
    setRecent(await api.get<MemEvent[]>("/api/memory/history?limit=30"));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const open = useCallback(async (path: string) => {
    setSelected(path);
    const r = await api.get<{ content: string }>(`/api/memory/file?path=${encodeURIComponent(path)}`);
    setContent(r.content);
    setOriginal(r.content);
    setHistory(await api.get<MemEvent[]>(`/api/memory/history?path=${encodeURIComponent(path)}`));
  }, []);

  useCrewEvent(
    (e) => {
      if (e.type !== "memory") return;
      load();
      if (e.path === selected && content === original) open(e.path);
    },
    [selected, content, original],
  );

  async function save() {
    if (!selected) return;
    await api.put("/api/memory/file", { path: selected, content });
    setOriginal(content);
    setHistory(await api.get<MemEvent[]>(`/api/memory/history?path=${encodeURIComponent(selected)}`));
    load();
  }

  async function remove() {
    if (!selected || !confirm(`Radera ${selected}? Boten glömmer detta.`)) return;
    await api.del(`/api/memory/file?path=${encodeURIComponent(selected)}`);
    setSelected(null);
    load();
  }

  const groups = useMemo(() => {
    const g: { title: string; key: string; files: MemFile[]; bot?: ReturnType<typeof crew.botById> }[] = [];
    g.push({ title: "Delat minne", key: "shared", files: (files ?? []).filter((f) => f.scope === "shared") });
    for (const b of crew.bots) g.push({ title: b.name, key: b.id, bot: b, files: (files ?? []).filter((f) => f.botId === b.id) });
    g.push({ title: "Skills", key: "skills", files: skills });
    return g;
  }, [files, skills, crew]);

  const label = (path: string) => {
    if (path.startsWith("shared/")) return `Delat / ${path.slice(7)}`;
    if (path.startsWith("skills/")) return `Skill / ${path.slice(7)}`;
    const id = path.split("/")[1];
    return `${crew.botById(id)?.name ?? "Bot"} / ${path.split("/")[2]}`;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-4 py-6">
        <PageHeader
          title="Minne & skills"
          subtitle="Allt botarna minns ligger som vanliga Markdown-filer. Läs, ändra, radera – eller ångra en ändring."
          actions={
            <Button variant="primary" onClick={() => setCreating(true)}>
              <FilePlus2 size={15} /> Ny fil
            </Button>
          }
        />
        {!files ? (
          <Spinner />
        ) : (
          <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
            <div className="space-y-3">
              {groups.map((g) => (
                <Card key={g.key} className="p-2">
                  <div className="flex items-center gap-2 px-2 py-1.5">
                    {g.bot ? <BotAvatar bot={g.bot} size={20} /> : g.key === "skills" ? <Wand2 size={16} className="text-lilac" /> : <Brain size={16} className="text-ember" />}
                    <span className="text-sm font-medium">{g.title}</span>
                    <span className="ml-auto text-xs text-faint">{g.files.length}</span>
                  </div>
                  {g.files.length === 0 && <div className="px-2 pb-1.5 text-xs text-faint">Inget sparat än.</div>}
                  {g.files.map((f) => (
                    <button
                      key={f.path}
                      onClick={() => open(f.path)}
                      className={cx(
                        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm",
                        selected === f.path ? "bg-raise text-ink" : "text-ink2 hover:bg-panel2",
                      )}
                    >
                      <span className="flex-1 truncate">{f.name.replace(/\.md$/, "")}</span>
                      <span className="text-[11px] text-faint">{timeAgo(f.updatedAt)}</span>
                    </button>
                  ))}
                </Card>
              ))}
            </div>

            <div className="min-w-0 space-y-4">
              {selected ? (
                <Card className="p-4">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <div className="min-w-0 flex-1 truncate font-medium">{label(selected)}</div>
                    <Button size="sm" variant="ghost" onClick={() => setShowHistory((s) => !s)}>
                      <History size={14} /> Historik ({history.length})
                    </Button>
                    <Button size="sm" variant="danger" onClick={remove}>
                      <Trash2 size={14} /> Radera
                    </Button>
                    <Button size="sm" variant="primary" onClick={save} disabled={content === original}>
                      <Save size={14} /> Spara
                    </Button>
                  </div>
                  <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={18} className="font-mono text-[13px] leading-relaxed" />
                  {showHistory && (
                    <div className="mt-4 space-y-2">
                      {history.map((h) => (
                        <div key={h.id} className="rounded-xl border border-line bg-panel2 p-3 text-sm">
                          <div className="flex items-center gap-2">
                            <span className="text-ink2">
                              {h.actor === "user" ? "Du" : (crew.botById(h.bot_id)?.name ?? "Bot")} · {ACTION[h.action] ?? h.action}
                            </span>
                            <span className="text-xs text-faint">{dateTime(h.ts)}</span>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="ml-auto"
                              onClick={async () => {
                                if (!confirm("Återställ filen till hur den såg ut före den här ändringen?")) return;
                                await api.post(`/api/memory/revert/${h.id}`);
                                open(selected);
                                load();
                              }}
                            >
                              <Undo2 size={13} /> Ångra
                            </Button>
                          </div>
                          {h.after && (
                            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-black/25 p-2 font-mono text-[11.5px] text-ink2">{h.after}</pre>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              ) : (
                <Card>
                  <Empty icon={<Brain size={28} />} title="Välj en fil" text="Eller se de senaste ändringarna nedan. Botarna sparar själva när de lär sig något om dig." />
                </Card>
              )}

              <Card className="p-4">
                <div className="mb-2 text-sm font-medium">Senaste ändringar</div>
                {recent.length === 0 && <div className="text-sm text-faint">Inga ändringar än.</div>}
                <div className="divide-y divide-line">
                  {recent.map((h) => (
                    <button key={h.id} onClick={() => h.action !== "delete" && open(h.path)} className="flex w-full items-start gap-3 py-2 text-left text-sm">
                      <span className="w-14 shrink-0 text-xs text-faint">{timeAgo(h.ts)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="text-ink2">
                          {h.actor === "user" ? "Du" : (crew.botById(h.bot_id)?.name ?? "Bot")} {ACTION[h.action] ?? h.action}{" "}
                        </span>
                        <span className="font-mono text-xs text-muted">{h.path}</span>
                        {h.preview && <span className="mt-0.5 block truncate text-xs text-faint">{h.preview.split("\n").slice(-1)[0]}</span>}
                      </span>
                    </button>
                  ))}
                </div>
              </Card>
            </div>
          </div>
        )}
      </div>
      <NewMemoryModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(p) => {
          setCreating(false);
          load().then(() => open(p));
        }}
      />
    </div>
  );
}

const ACTION: Record<string, string> = { create: "skapade", update: "ändrade", append: "lade till i", delete: "raderade" };

function NewMemoryModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (path: string) => void }) {
  const crew = useCrew();
  const [scope, setScope] = useState("shared");
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const path = scope === "shared" ? `shared/${slug}.md` : scope === "skills" ? `skills/${slug}.md` : `bots/${scope}/${slug}.md`;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Ny minnesfil"
      footer={
        <Button
          variant="primary"
          disabled={!slug}
          onClick={async () => {
            await api.put("/api/memory/file", { path, content });
            setName("");
            setContent("");
            onCreated(path);
          }}
        >
          Skapa
        </Button>
      }
    >
      <div className="space-y-3">
        <Select value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="shared">Delat minne (alla botar)</option>
          {crew.bots.map((b) => (
            <option key={b.id} value={b.id}>
              Bara {b.name}
            </option>
          ))}
          <option value="skills">Skill (återanvändbart arbetsflöde)</option>
        </Select>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Namn, t.ex. om-mig" />
        <Textarea rows={8} value={content} onChange={(e) => setContent(e.target.value)} placeholder="- Jag heter …&#10;- Jag föredrar …" className="font-mono text-[13px]" />
        <div className="text-xs text-faint">Sparas som {path}</div>
      </div>
    </Modal>
  );
}

export default function Page() {
  return (
    <Shell>
      <MemoryPage />
    </Shell>
  );
}
