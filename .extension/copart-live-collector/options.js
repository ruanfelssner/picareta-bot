const API_ORIGIN = "https://picareta-bot.felss.dev";
const EXTENSION_TOKEN_STORAGE_KEY = "liveAuctionExtensionToken";
const DEFAULT_EXTENSION_TOKEN = "7d7c05e46b7d60e29a77dbe62def6dfa389b53e73db15be41dcd83d61bf73b11";

const tokenInput = document.querySelector("#token");
const saveButton = document.querySelector("#save");
const testButton = document.querySelector("#test");
const statusElement = document.querySelector("#status");

void loadToken();

saveButton.addEventListener("click", async () => {
  await saveToken();
  showStatus("Token salvo na extensão.", "success");
});

testButton.addEventListener("click", async () => {
  setBusy(true);
  try {
    const token = await saveToken();
    const response = await chrome.runtime.sendMessage({
      type: "LIVE_AUCTION_API_REQUEST",
      endpoint: `${API_ORIGIN}/api/vehicles/extension-auth`,
      method: "GET",
    });

    if (response?.ok) {
      showStatus("Conexão autorizada com o backend.", "success");
      return;
    }

    const message = response?.status === 401
      ? "Token recusado pelo backend. Confira se os valores são iguais."
      : response?.body?.message || "Não foi possível validar a conexão.";
    showStatus(message, "error");
  }
  catch (error) {
    showStatus(error instanceof Error ? error.message : "Falha ao testar a conexão.", "error");
  }
  finally {
    setBusy(false);
  }
});

async function loadToken() {
  const stored = await chrome.storage.local.get(EXTENSION_TOKEN_STORAGE_KEY);
  tokenInput.value = typeof stored[EXTENSION_TOKEN_STORAGE_KEY] === "string"
    ? stored[EXTENSION_TOKEN_STORAGE_KEY]
    : DEFAULT_EXTENSION_TOKEN;
}

async function saveToken() {
  const token = tokenInput.value.trim() || DEFAULT_EXTENSION_TOKEN;
  if (token !== DEFAULT_EXTENSION_TOKEN) {
    await chrome.storage.local.set({ [EXTENSION_TOKEN_STORAGE_KEY]: token });
  }
  else {
    await chrome.storage.local.remove(EXTENSION_TOKEN_STORAGE_KEY);
  }
  tokenInput.value = token;
  return token;
}

function showStatus(message, type) {
  statusElement.textContent = message;
  statusElement.className = type;
}

function setBusy(value) {
  saveButton.disabled = value;
  testButton.disabled = value;
}
