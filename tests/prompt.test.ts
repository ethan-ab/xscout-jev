import { describe, expect, it } from "vitest";
import { compileProfile, loadScout, parseProfile } from "../src/profile";
import { draftPrompt } from "../src/prompt";

const scout = loadScout("profiles/ai-apps.yaml");

describe("draftPrompt", () => {
  it("contains the update, actions, every source URL and the organisation", () => {
    const p = draftPrompt(scout, { title: "ChatGPT Voice can now use plugins", actions: ["explainer"] }, [
      { author: "OpenAI", text: "Voice can now use plugins", url: "https://x.com/OpenAI/status/1" },
      { author: "reach_vb", text: "Massive QoL update", url: "https://x.com/reach_vb/status/2" },
    ]);
    expect(p).toContain("Update: ChatGPT Voice can now use plugins");
    expect(p).toContain("Suggested angles: explainer");
    expect(p).toContain("https://x.com/OpenAI/status/1");
    expect(p).toContain("https://x.com/reach_vb/status/2");
    expect(p).toContain("Acme is an independent newsletter");
  });

  it("fills the draft template", () => {
    const r = compileProfile(
      parseProfile({
        ...loadScout("profiles/starter.yaml").profile,
        org: { name: "Bean Co", about: "Bean Co roasts coffee." },
        draft: { template: "{org}: {title} [{actions}]\n{sources}" },
      }),
    );
    const text = draftPrompt(r, { title: "New roaster {beta}", actions: [] }, [{ author: "a", text: "hot  {take}", url: "u" }]);
    expect(text).toBe("Bean Co: New roaster {beta} [pick the best one]\n- @a (u): hot {take}");
  });
});
