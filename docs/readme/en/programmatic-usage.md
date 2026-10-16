# 💻 Programmatic Usage

> [⬅ Back to README](../../../README.md)


### Basic Single-turn Call

```typescript
import { agent } from './src/agent/react-agent.js';
import { registerBuiltinTools } from './src/tools/index.js';

// Register built-in tools (only needed once per process)
registerBuiltinTools();

// Single call
const result = await agent.run('Read the version from package.json', {
  verbose: true,       // Output Thought/Action/Observation logs
  resetHistory: true,  // Clear history and start a new session
});

console.log(result.answer);
console.log(`Iterations: ${result.iterations}, Steps: ${result.steps.length}`);
```

### Multi-turn Conversation

```typescript
// Turn 1: read package.json
const r1 = await agent.run('What is the project name in package.json?', {
  resetHistory: true,
  verbose: false,
});
console.log(r1.answer);

// Turn 2 — history context is reused automatically; no need to pass messages explicitly
const r2 = await agent.run('And what is its version?');
// The agent already knows package.json's content and can answer directly without calling tools again
console.log(r2.answer);
```

### Session Persistence

```typescript
import { agent } from './src/agent/react-agent.js';
import { SessionStore } from './src/session/index.js';
import { registerBuiltinTools } from './src/tools/index.js';

registerBuiltinTools();

// Initialize the session store (isolated by the current workspace path)
const sessionStore = new SessionStore(process.cwd());
await sessionStore.init();
agent.setSessionStore(sessionStore);

// If session.autoSave=true, a session is created/updated automatically after run()
const result = await agent.run('Read package.json', {
  resetHistory: true,
  verbose: true,
});
console.log(`Session ID: ${agent.currentSessionId}`);
```

### Custom Event Listeners

```typescript
import { agent } from './src/agent/react-agent.js';
import type { AgentEvents } from './src/types.js';

// Custom listener
const myListener: AgentEvents = {
  onToolStart: (tool, args) => {
    console.log(`[🔧 Tool start] ${tool}`, args);
  },
  onToolEnd: (tool, result) => {
    console.log(`[✅ Tool done] ${tool} → ${result.slice(0, 100)}...`);
  },
  onFinal: (answer) => {
    console.log(`[🎯 Final answer] ${answer}`);
  },
};

const result = await agent.run('Search for config in the src directory', {
  verbose: false,
  events: [myListener],
});
```
