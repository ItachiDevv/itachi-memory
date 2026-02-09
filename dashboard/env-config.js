// Default environment config — overwritten at build time by build.sh
// This file allows the dashboard to work locally without a build step.
window.__ITACHI_ENV__ = {
  apiUrl: "https://itachisbrainserver.online",
  apiKey: "",
  refreshInterval: 10,
  orchestratorUrl: "http://localhost:3001"
};
