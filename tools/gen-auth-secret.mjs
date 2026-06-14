#!/usr/bin/env node
const bytes = new Uint8Array(32);
crypto.getRandomValues(bytes);
console.log([...bytes].map((b) => b.toString(16).padStart(2, "0")).join(""));
