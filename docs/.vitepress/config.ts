import { defineConfig } from "vitepress";

const base = process.env.DOCS_BASE ?? "/homebridge-eufy-security/";

export default defineConfig({
  title: "Homebridge Eufy",
  description: "Homebridge 2 integration for verified eufy device capabilities. Independent and unofficial.",
  base,
  head: [["link", { rel: "icon", type: "image/svg+xml", href: `${base}favicon.svg` }]],
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: false,
  themeConfig: {
    logo: { light: "/logo.svg", dark: "/logo-dark.svg", alt: "Homebridge Eufy" },
    outline: [2, 3],
    nav: [
      { text: "Guide", link: "/guide/v5-status" },
      { text: "Reference", link: "/reference/configuration" },
      { text: "Troubleshooting", link: "/troubleshooting/" },
      { text: "Legacy V4", link: "/legacy/v4/" },
    ],
    sidebar: {
      "/": [
        {
          text: "Getting started",
          items: [
            { text: "V5 closed-beta status", link: "/guide/v5-status" },
            { text: "Requirements", link: "/guide/requirements" },
            { text: "Installation", link: "/guide/installation" },
            { text: "Dedicated account", link: "/guide/dedicated-account" },
            { text: "First-time setup", link: "/guide/first-time-setup" },
            { text: "Uninstallation", link: "/guide/uninstallation" },
          ],
        },
        {
          text: "Reference",
          items: [
            { text: "Configuration", link: "/reference/configuration" },
            { text: "Authentication lifecycle", link: "/reference/authentication-lifecycle" },
            { text: "Runtime states", link: "/reference/runtime-states" },
            { text: "Supported capabilities", link: "/reference/supported-capabilities" },
          ],
        },
        {
          text: "Features",
          items: [
            { text: "Contact sensors", link: "/features/contact-sensors" },
            { text: "Cameras, streaming & HKSV", link: "/features/cameras" },
          ],
        },
        {
          text: "Troubleshooting",
          items: [
            { text: "Overview", link: "/troubleshooting/" },
            { text: "Authentication", link: "/troubleshooting/authentication" },
            { text: "Discovery & runtime", link: "/troubleshooting/discovery-runtime" },
            { text: "Node.js compatibility", link: "/troubleshooting/node-compatibility" },
            { text: "Collecting diagnostics", link: "/troubleshooting/collecting-diagnostics" },
          ],
        },
        {
          text: "Legacy V4",
          collapsed: true,
          items: [
            { text: "Legacy documentation", link: "/legacy/v4/" },
            { text: "Installation & configuration", link: "/legacy/v4/installation-configuration" },
            { text: "Bridged & unbridged", link: "/legacy/v4/bridged-unbridged" },
            { text: "Streaming settings", link: "/legacy/v4/streaming" },
            { text: "Troubleshooting", link: "/legacy/v4/troubleshooting" },
            { text: "Common issues", link: "/legacy/v4/common-issues" },
            { text: "Prerelease versions", link: "/legacy/v4/prerelease-versions" },
          ],
        },
        {
          text: "Under the hood",
          items: [
            { text: "Architecture", link: "/architecture" },
            { text: "Hardware encoder viability", link: "/reference/hardware-encoder-viability" },
          ],
        },
      ],
    },
    search: { provider: "local" },
    socialLinks: [
      { icon: "github", link: "https://github.com/homebridge-plugins/homebridge-eufy-security" },
      { icon: "discord", link: "https://discord.gg/5wjQ2asb64" },
    ],
    footer: {
      message:
        "Independent and unofficial. Not affiliated with, endorsed by, or sponsored by Anker " +
        "Innovations or eufy. Use responsibly — rapid or failed logins can trigger captcha or temporary cooldowns.",
    },
  },
});
