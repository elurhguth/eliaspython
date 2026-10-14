"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { Shell } from "@/components/Shell";
import { ChatView } from "@/components/Chat";
import { Home } from "@/components/Home";
import { useCrew } from "@/lib/store";

function Main() {
  const params = useSearchParams();
  const router = useRouter();
  const crew = useCrew();
  const t = params.get("t");
  const bot = params.get("bot");

  // ?bot=<id>: open that bot's latest direct chat, or start a new one.
  const latest = bot ? crew.threads.find((th) => th.kind === "direct" && th.bot_ids.length === 1 && th.bot_ids[0] === bot) : undefined;
  useEffect(() => {
    if (bot && latest && !params.get("new")) router.replace(`/?t=${latest.id}&bot=${bot}`);
  }, [bot, latest, params, router]);

  if (t) return <ChatView threadId={t} />;
  return <Home preselectBotId={bot} />;
}

export default function Page() {
  return (
    <Shell>
      <Suspense>
        <Main />
      </Suspense>
    </Shell>
  );
}
