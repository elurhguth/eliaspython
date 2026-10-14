"use client";

import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useCrew } from "@/lib/store";
import type { Bot } from "@/lib/types";
import { BotAvatar, Button, Field, Input, Modal, Select, Textarea, Toggle } from "./ui";
import { ModelPicker } from "./ModelPicker";
import { VoiceSettings } from "./Voice";

const EMOJIS = ["🧭", "🔎", "✉️", "📅", "📣", "🧾", "🛒", "🧠", "🛠️", "📊", "✍️", "🎯", "🌱", "🦊", "🐙", "🤖"];
const COLORS = ["#e8a25c", "#7cb7a6", "#a99be0", "#e5695b", "#6fa8dc", "#d7c46a", "#c78bb5", "#9aa5b1"];

type Policy = { bot_id: string; action_type: string; decision: "allow" | "deny" };

export function BotEditor({ bot, open, onClose }: { bot: Bot | null; open: boolean; onClose: () => void }) {
  const { refreshBots, defaultModel, actionTypes } = useCrew();
  const [form, setForm] = useState<Partial<Bot>>({});
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setError("");
    setForm(
      bot ?? {
        name: "",
        role: "",
        avatar: EMOJIS[Math.floor(Math.random() * EMOJIS.length)],
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        instructions: "",
        provider: defaultModel.provider,
        model: defaultModel.model,
        is_lead: false,
        voice: {},
      },
    );
    if (bot) api.get<{ policies: Policy[] }>("/api/policies").then((r) => setPolicies(r.policies.filter((p) => p.bot_id === bot.id)));
    else setPolicies([]);
  }, [open, bot, defaultModel]);

  const set = (k: keyof Bot, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setSaving(true);
    setError("");
    try {
      if (bot) await api.patch(`/api/bots/${bot.id}`, form);
      else await api.post("/api/bots", form);
      await refreshBots();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!bot || !confirm(`Ta bort ${bot.name}? Botens privata chattar raderas.`)) return;
    await api.del(`/api/bots/${bot.id}`);
    await refreshBots();
    onClose();
  }

  async function setPolicy(actionType: string, decision: string) {
    if (!bot) return;
    await api.put("/api/policies", { botId: bot.id, actionType, decision: decision === "ask" ? null : decision });
    const r = await api.get<{ policies: Policy[] }>("/api/policies");
    setPolicies(r.policies.filter((p) => p.bot_id === bot.id));
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={
        <span className="flex items-center gap-3">
          <BotAvatar bot={form as Bot} size={30} />
          {bot ? `Redigera ${bot.name}` : "Ny bot"}
        </span>
      }
      footer={
        <>
          {bot && (
            <Button variant="danger" onClick={remove} className="mr-auto">
              <Trash2 size={15} /> Ta bort
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button variant="primary" onClick={save} disabled={saving || !form.name?.trim()}>
            {bot ? "Spara" : "Skapa bot"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Namn">
          <Input value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} placeholder="t.ex. Vera" autoFocus={!bot} />
        </Field>
        <Field label="Roll" hint="Visas i sidopanelen och för de andra botarna.">
          <Input value={form.role ?? ""} onChange={(e) => set("role", e.target.value)} placeholder="t.ex. Chief of staff" />
        </Field>
        {bot && (
          <Field label="@namn" hint="Används för att tagga boten i gruppchattar.">
            <Input value={(form as Bot).slug ?? ""} onChange={(e) => set("slug" as keyof Bot, e.target.value)} />
          </Field>
        )}
        <Field label="Modell" hint="Valfri modell per bot – Anthropic, xAI eller annan OpenAI-kompatibel.">
          <ModelPicker provider={form.provider ?? ""} model={form.model ?? ""} onChange={(p, m) => setForm((f) => ({ ...f, provider: p, model: m }))} />
        </Field>
      </div>

      <div className="mt-4">
        <div className="mb-1.5 text-[13px] font-medium text-ink2">Avatar & färg</div>
        <div className="flex flex-wrap gap-1.5">
          {EMOJIS.map((e) => (
            <button
              key={e}
              onClick={() => set("avatar", e)}
              className={`h-9 w-9 rounded-xl text-lg ${form.avatar === e ? "bg-raise ring-1 ring-ember" : "hover:bg-raise"}`}
            >
              {e}
            </button>
          ))}
          <input
            value={EMOJIS.includes(form.avatar ?? "") ? "" : (form.avatar ?? "")}
            onChange={(e) => set("avatar", e.target.value.slice(0, 4))}
            placeholder="annan"
            className="h-9 w-16 rounded-xl border border-line bg-panel2 px-2 text-center text-sm outline-none"
          />
        </div>
        <div className="mt-2 flex gap-1.5">
          {COLORS.map((c) => (
            <button
              key={c}
              onClick={() => set("color", c)}
              className={`h-7 w-7 rounded-full ${form.color === c ? "ring-2 ring-ink ring-offset-2 ring-offset-panel" : ""}`}
              style={{ background: c }}
              aria-label={c}
            />
          ))}
        </div>
      </div>

      <div className="mt-4">
        <Field label="Instruktioner" hint="Hur boten ska jobba, ton, vad den ansvarar för. Den lär sig mer över tid via minnet.">
          <Textarea rows={6} value={form.instructions ?? ""} onChange={(e) => set("instructions", e.target.value)} placeholder="Du ansvarar för…" />
        </Field>
      </div>

      <div className="mt-4 flex items-center justify-between rounded-xl border border-line bg-panel2 px-3 py-2.5">
        <div>
          <div className="text-sm font-medium">Teamledare</div>
          <div className="text-xs text-muted">Svarar i gruppchattar när ingen är taggad och fördelar arbetet.</div>
        </div>
        <Toggle checked={!!form.is_lead} onChange={(v) => set("is_lead", v)} />
      </div>

      {bot && (
        <div className="mt-5">
          <div className="mb-1 text-[13px] font-medium text-ink2">Godkännanden</div>
          <div className="mb-2 text-xs text-muted">Vad ska {bot.name} få göra utan att fråga? Standard är att alltid fråga.</div>
          <div className="divide-y divide-line rounded-xl border border-line">
            {Object.entries(actionTypes).map(([key, label]) => {
              const p = policies.find((x) => x.action_type === key);
              return (
                <div key={key} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="text-sm">{label}</span>
                  <Select className="h-8 w-40 text-xs" value={p?.decision ?? "ask"} onChange={(e) => setPolicy(key, e.target.value)}>
                    <option value="ask">Fråga först</option>
                    <option value="allow">Tillåt alltid</option>
                    <option value="deny">Neka alltid</option>
                  </Select>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-5">
        <VoiceSettings value={form.voice ?? {}} onChange={(v) => set("voice", v)} />
      </div>

      {error && <div className="mt-3 text-sm text-danger">{error}</div>}
    </Modal>
  );
}
