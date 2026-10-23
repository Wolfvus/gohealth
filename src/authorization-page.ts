type AuthorizationStage = "connect" | "exporting" | "invalid" | "failed";

const stages = {
  connect: {
    step: "01 / CONNECT",
    title: "Your health data.<br>On your terms.",
    description:
      "Connect your Google account to export your health history to this computer. Explore your trends in a local dashboard.",
    action:
      '<a class="button" href="/auth">Connect Google Health <span aria-hidden="true">→</span></a>',
    detail:
      "Google will ask you to approve read-only access. You choose which permissions to grant.",
  },
  exporting: {
    step: "02 / EXPORT",
    title: "Connected.<br>Your export is running.",
    description:
      "Authorization is complete. Keep the terminal open while GoHealth downloads your data. You can close this browser tab.",
    action:
      '<div class="command"><span>When the terminal confirms “Export saved”</span><code>goh start<br>goh open</code></div>',
    detail:
      "These commands import your export and open the local dashboard. Sign in with the Grafana credentials you configured.",
  },
  invalid: {
    step: "CONNECTION INCOMPLETE",
    title: "Let’s connect again.",
    description:
      "This authorization link is invalid or incomplete. Return to your terminal and restart authorization.",
    action:
      '<div class="command"><span>Run in your GoHealth directory</span><code>goh auth</code></div>',
    detail:
      "Stop the previous authorization command first, then use the new link printed in your terminal.",
  },
  failed: {
    step: "CONNECTION INCOMPLETE",
    title: "Couldn’t finish connecting.",
    description:
      "Authorization or export failed. Check the error in your terminal, then press Ctrl+C to stop the previous command before trying again.",
    action:
      '<div class="command"><span>Restart authorization from your terminal</span><code>goh auth</code></div>',
    detail:
      "Keep your credentials and exported health data private when sharing troubleshooting details.",
  },
} satisfies Record<
  AuthorizationStage,
  {
    step: string;
    title: string;
    description: string;
    action: string;
    detail: string;
  }
>;

// Only fixed copy is rendered here; OAuth parameters and provider errors never enter HTML.
export function authorizationPage(stage: AuthorizationStage): string {
  const content = stages[stage];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>GoHealth · ${stage === "connect" ? "Connect your data" : "Authorization"}</title>
<style>
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  background: #fafafa;
  color: #171717;
  font:
    16px/1.65 -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}
a {
  color: inherit;
}
header,
main,
footer {
  width: min(100% - 48px, 960px);
  margin: auto;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  padding: 28px 0;
  border-bottom: 1px solid #e5e5e5;
}
.brand {
  font-size: 19px;
  font-weight: 650;
  letter-spacing: -0.7px;
}
.local {
  font:
    12px ui-monospace,
    monospace;
  color: #525252;
}
main {
  padding: 72px 0 56px;
}
.eyebrow {
  font:
    12px ui-monospace,
    monospace;
  letter-spacing: 1.2px;
  color: #666;
}
h1 {
  font-size: clamp(36px, 6vw, 60px);
  line-height: 1.1;
  letter-spacing: -2.2px;
  font-weight: 600;
  margin: 24px 0;
}
p {
  max-width: 560px;
  color: #525252;
  margin: 0 0 28px;
}
.button {
  display: inline-flex;
  gap: 32px;
  align-items: center;
  background: #171717;
  color: #fff;
  text-decoration: none;
  padding: 13px 20px;
  border: 1px solid #171717;
  border-radius: 7px;
  font-size: 14px;
  font-weight: 600;
}
.button:hover {
  background: #333;
}
.button:focus-visible {
  outline: 3px solid #2563eb;
  outline-offset: 4px;
}
.detail {
  font-size: 13px;
  margin: 16px 0 48px;
  max-width: 480px;
}
.flow {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  border-top: 1px solid #e5e5e5;
  padding-top: 24px;
  gap: 32px;
}
.flow b {
  font-size: 14px;
  font-weight: 600;
}
.flow p {
  font-size: 13px;
  margin: 8px 0 0;
}
.number {
  font:
    11px ui-monospace,
    monospace;
  color: #737373;
  margin-right: 8px;
}
footer {
  border-top: 1px solid #e5e5e5;
  padding: 20px 0 32px;
  font-size: 12px;
  color: #666;
}
.command {
  max-width: 560px;
  padding: 20px;
  border: 1px solid #ddd;
  border-radius: 8px;
  background: #fff;
}
.command span {
  display: block;
  font-size: 12px;
  color: #666;
  margin-bottom: 12px;
}
code {
  font:
    15px/1.8 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
@media (max-width: 600px) {
  header,
  main,
  footer {
    width: calc(100% - 40px);
  }
  main {
    padding: 48px 0 32px;
  }
  .flow {
    grid-template-columns: 1fr;
    gap: 24px;
  }
  .detail {
    margin-bottom: 36px;
  }
  h1 {
    letter-spacing: -1.4px;
  }
  .local {
    font-size: 11px;
  }
}
</style></head><body>
<header><span class="brand">GoHealth</span><span class="local">LOCAL FIRST / PRIVATE BY DEFAULT</span></header>
<main><div class="eyebrow">${content.step}</div><h1>${content.title}</h1><p>${content.description}</p>${content.action}<p class="detail">${content.detail}</p>
<section class="flow" aria-label="How GoHealth works"><div><b><span class="number">01</span>Connect</b><p>Authorize read-only access through Google. Your tokens stay on this computer.</p></div><div><b><span class="number">02</span>Export</b><p>Save a copy of your health history locally.</p></div><div><b><span class="number">03</span>Explore</b><p>See sleep, activity, and personal trends in your Grafana dashboard.</p></div></section></main>
<footer>Independent open-source project. General wellness insights, not medical advice.</footer></body></html>`;
}
