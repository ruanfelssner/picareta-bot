<template>
  <div class="app">
    <nav class="nav">
      <span class="nav-brand">🚗 Bot Anúncios</span>
      <div class="nav-links">
        <NuxtLink to="/cars" class="nav-link">Veículos</NuxtLink>
        <NuxtLink to="/saves" class="nav-link">Favoritos</NuxtLink>
      </div>
    </nav>
    <main class="main">
      <slot />
    </main>
  </div>
</template>

<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #0f1117;
  color: #e2e8f0;
  font-size: 14px;
  line-height: 1.5;
}

a { color: inherit; text-decoration: none; }
button { cursor: pointer; font-family: inherit; font-size: inherit; }
input, select, textarea { font-family: inherit; font-size: inherit; }
</style>

<style scoped>
.app {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.nav {
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 0 20px;
  height: 48px;
  background: #1a1d27;
  border-bottom: 1px solid #2d3148;
  position: sticky;
  top: 0;
  z-index: 100;
}

.nav-brand {
  font-weight: 600;
  font-size: 15px;
  color: #a78bfa;
  margin-right: 8px;
}

.nav-links {
  display: flex;
  gap: 4px;
}

.nav-link {
  padding: 6px 14px;
  border-radius: 6px;
  color: #94a3b8;
  font-size: 13px;
  font-weight: 500;
  transition: background 0.15s, color 0.15s;
}

.nav-link:hover { background: #2d3148; color: #e2e8f0; }
.nav-link.router-link-active { background: #2d3148; color: #a78bfa; }

.main {
  flex: 1;
  padding: 20px;
  width: 100%;
  margin: 0 auto;
}
</style>
