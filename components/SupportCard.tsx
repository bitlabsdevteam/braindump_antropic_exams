"use client";

import { useState } from "react";

const suiAddress = "0x7b09a37523422e5e35950279b3585c2e4ad03c05b883e8cd337fbb4e1c584ec9";

export default function SupportCard() {
  const [copied, setCopied] = useState(false);

  async function copyAddress() {
    await navigator.clipboard.writeText(suiAddress);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2200);
  }

  return <section className="support-section" aria-labelledby="support-title">
    <p className="eyebrow">Support the project</p><h2 id="support-title">Buy me a cup of <em>coffee.</em></h2><p>If these practice sets help you prepare, you can support the project with SUI tokens.</p><div className="support-address"><span>Sui wallet address</span><code>{suiAddress}</code><button className="button" type="button" onClick={copyAddress}>{copied ? "Copied ✓" : "Copy address"}</button></div>
  </section>;
}
