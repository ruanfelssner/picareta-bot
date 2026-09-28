const loginView = document.querySelector("#login-view");
const sessionView = document.querySelector("#session-view");
const loginForm = document.querySelector("#login-form");
const phoneInput = document.querySelector("#phone");
const passwordInput = document.querySelector("#password");
const loginButton = document.querySelector("#login");
const testButton = document.querySelector("#test");
const validateButton = document.querySelector("#validate");
const logoutButton = document.querySelector("#logout");
const userName = document.querySelector("#user-name");
const userPhone = document.querySelector("#user-phone");
const sessionExpiry = document.querySelector("#session-expiry");
const statusElement = document.querySelector("#status");

void loadSession(false);

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(true);
  showStatus("Entrando no Picareta...", "");
  try {
    const response = await chrome.runtime.sendMessage({
      type: "PICARETA_EXTENSION_LOGIN",
      phone: phoneInput.value,
      password: passwordInput.value,
    });
    if (!response?.ok) throw new Error(response?.body?.message || "Não foi possível entrar no Picareta.");
    passwordInput.value = "";
    renderSession(response.body);
    showStatus("Conta conectada. As capturas serão identificadas com este usuário.", "success");
  }
  catch (error) {
    showStatus(error instanceof Error ? error.message : "Falha ao entrar.", "error");
  }
  finally {
    setBusy(false);
  }
});

testButton.addEventListener("click", () => loadSession(true));
validateButton.addEventListener("click", () => loadSession(true));
logoutButton.addEventListener("click", async () => {
  setBusy(true);
  await chrome.runtime.sendMessage({ type: "PICARETA_EXTENSION_LOGOUT" });
  renderLoggedOut();
  showStatus("Conta desconectada da extensão.", "success");
  setBusy(false);
});

async function loadSession(validate) {
  setBusy(true);
  try {
    const response = await chrome.runtime.sendMessage({ type: "PICARETA_EXTENSION_SESSION", validate });
    if (response?.ok && response.body?.authenticated) {
      renderSession(response.body);
      if (validate) showStatus("Conexão com o Picareta confirmada.", "success");
      return;
    }
    renderLoggedOut();
    if (validate && response?.status === 401) {
      showStatus(response?.body?.message || "A sessão expirou. Entre novamente.", "error");
    }
  }
  catch (error) {
    showStatus(error instanceof Error ? error.message : "Falha ao verificar a sessão.", "error");
  }
  finally {
    setBusy(false);
  }
}

function renderSession(body) {
  const user = body?.user || {};
  loginView.hidden = true;
  sessionView.hidden = false;
  userName.textContent = typeof user.name === "string" ? user.name : "Usuário do Picareta";
  userPhone.textContent = formatPhone(user.phone);
  sessionExpiry.textContent = body?.expiresAt
    ? `Sessão válida até ${new Date(body.expiresAt).toLocaleDateString("pt-BR")}`
    : "Sessão conectada";
}

function renderLoggedOut() {
  loginView.hidden = false;
  sessionView.hidden = true;
  userName.textContent = "";
  userPhone.textContent = "";
  sessionExpiry.textContent = "";
}

function formatPhone(value) {
  const digits = String(value || "").replace(/\D/g, "").slice(-11);
  return digits.length === 11
    ? `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`
    : String(value || "");
}

function showStatus(message, type) {
  statusElement.textContent = message;
  statusElement.className = type;
}

function setBusy(value) {
  for (const button of [loginButton, testButton, validateButton, logoutButton]) button.disabled = value;
}
