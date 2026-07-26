// SV1-ELECTRON-04: daemon status is untrusted text — rendered via textContent only.
const api = window.agentsFleet;
const el = document.getElementById("status");

const poll = async () => {
  try {
    el.textContent = await api.getConnectionInfo();
  } catch (error) {
    el.textContent = `error: ${String(error)}`;
  }
};

void poll();
setInterval(() => void poll(), 500);
