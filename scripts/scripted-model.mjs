#!/usr/bin/env node
/**
 * Deterministic stand-in for the OpenRouter API used to exercise the agent loop
 * end to end without consuming real model quota. It only fakes the *model
 * transport*: every tool the agent asks for (file edits, commands, Gradle
 * builds) still runs for real through the normal backend code paths.
 *
 * Scenario: the project contains a Kotlin compile error. The scripted model
 * reads the failing file, rewrites it correctly, then declares done. The loop's
 * own VERIFY phase runs the real Gradle build afterwards.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const PORT = Number(process.env.PORT || 9099);
const PROJECT_DIR = process.env.PROJECT_DIR;
const REL_FILE = 'app/src/main/java/com/myaistudio/calculator/MainActivity.kt';

const FIXED = `package com.myaistudio.calculator

import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val layout = android.widget.LinearLayout(this).apply { orientation = android.widget.LinearLayout.VERTICAL }
        val left = EditText(this).apply { hint = "First number" }
        val right = EditText(this).apply { hint = "Second number" }
        val result = TextView(this)
        val add = Button(this).apply { text = "Add" }
        add.setOnClickListener {
            val a = left.text.toString().toDoubleOrNull() ?: 0.0
            val b = right.text.toString().toDoubleOrNull() ?: 0.0
            result.text = Calculator.add(a, b).toString()
        }
        layout.addView(left)
        layout.addView(right)
        layout.addView(add)
        layout.addView(result)
        setContentView(layout)
    }
}
`;

// Steps the scripted model walks through, in order. Each is emitted once.
const script = [
  { done: false, tool: 'read_file', args: { path: REL_FILE }, reason: 'read the file the compiler complained about' },
  { done: false, tool: 'edit_file', args: { path: REL_FILE, content: FIXED }, reason: 'fix the compile error' },
  { done: false, tool: 'build_android', args: { target: 'debug' }, reason: 'rebuild to confirm the fix' },
  { done: true, summary: 'Fixed the Kotlin compile error and rebuilt the debug APK.' },
];

let step = 0;

function completion(text) {
  return {
    id: 'gen-local',
    object: 'chat.completion',
    model: 'local/scripted',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(404).end('not found');
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;

  // Record what the loop asked for, so the test can prove tools ran.
  const body = JSON.parse(raw || '{}');
  const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
  await fs.appendFile(
    path.join(PROJECT_DIR, '.scripted-model-calls.log'),
    JSON.stringify({ step, lastUser: (lastUser?.content ?? '').slice(0, 200) }) + '\n',
  ).catch(() => {});

  const next = script[Math.min(step, script.length - 1)];
  step += 1;
  const content = next.done
    ? JSON.stringify({ done: true, summary: next.summary })
    : JSON.stringify({ tool: next.tool, args: next.args, reason: next.reason });

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(completion(content)));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`scripted model listening on ${PORT}`);
});
