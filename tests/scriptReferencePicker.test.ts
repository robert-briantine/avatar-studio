import assert from "node:assert/strict";
import test from "node:test";
import { parseAvatarScript } from "../src/avatarScript.js";
import { completeReference, referenceTrigger } from "../public/scriptReferencePicker.js";

test("reference assistance starts only at an empty Ref command at the insertion caret", () => {
  for (const prefix of ["{Ref:", "Avant. {Ref: ", "Avant. {Ref:  \t"]) {
    const trigger = referenceTrigger(prefix, prefix.length);
    assert.ok(trigger);
    const completed = completeReference(prefix, trigger, "FormuleEnergie");
    assert.ok(completed);
    const script = parseAvatarScript(completed.value + " Voici la formule.");
    assert.equal(script.sequences.at(-1)?.mode, "ref");
    assert.equal(script.sequences.at(-1)?.content, "FormuleEnergie");
  }
  for (const value of ["{ref:", "{Image:", "{Ref:Nom", "{Ref:Nom}", "Ref:", "{Ref :"]) {
    assert.equal(referenceTrigger(value, value.length), null, value);
  }
  assert.equal(referenceTrigger("{Ref:", 5, 6), null, "an active selection must not be replaced");
  assert.equal(referenceTrigger("{Ref:", -1), null);
  assert.equal(referenceTrigger("{Ref:", 6), null);
});

test("reference assistance follows the language escape rules for literal braces and backslashes", () => {
  for (let count = 0; count <= 8; count++) {
    const source = "\\".repeat(count) + "{Ref:";
    const trigger = referenceTrigger(source, source.length);
    assert.equal(Boolean(trigger), count % 2 === 0, `prefix of ${count} backslashes`);
    if (trigger) {
      const completed = completeReference(source, trigger, "FondCours")!;
      const script = parseAvatarScript(completed.value + " Support.");
      assert.equal(script.sequences.at(-1)?.content, "FondCours");
      assert.equal(script.sequences.at(-1)?.text, "Support.");
    }
  }
  const literal = String.raw`Voici \{Ref:Nom\}. {Ref:`;
  assert.ok(referenceTrigger(literal, literal.length));
});

test("a reference inside another visual command does not open the picker", () => {
  for (const source of ["{Texte: {Ref:", String.raw`{Latex: \frac{x}{y} + {Ref:`, "{Image: un panneau {Ref:"]) {
    assert.equal(referenceTrigger(source, source.length), null, source);
  }
  const source = String.raw`{Latex: \frac{x}{y} + \left\{ z \right.} Une formule. {Ref:`;
  const trigger = referenceTrigger(source, source.length);
  assert.ok(trigger);
  const script = parseAvatarScript(completeReference(source, trigger, "Code")!.value + " Un exemple.");
  assert.deepEqual(script.sequences.map(sequence => sequence.mode), ["latex", "ref"]);
});

test("completion replaces the placeholder in the middle without changing surrounding narration or commands", () => {
  for (const placeholder of ["{Ref:", "{Ref:}", "{Ref:   }", "{Ref: \t}"]) {
    const prefix = "Début. {Texte:Titre} Présentation. {} Suite. ";
    const suffix = " Voici le support. {Image:une licorne} Continuons. {} Fin.";
    const source = prefix + placeholder + suffix;
    const trigger = referenceTrigger(source, prefix.length + 5);
    assert.ok(trigger);
    const completed = completeReference(source, trigger, "FondCours")!;
    assert.equal(completed.value, prefix + "{Ref:FondCours}" + suffix);
    assert.equal(completed.caret, prefix.length + "{Ref:FondCours}".length);
    const script = parseAvatarScript(completed.value);
    assert.equal(script.narration, "Début. Présentation. Suite. Voici le support. Continuons. Fin.");
    assert.deepEqual(script.sequences.map(sequence => sequence.mode), ["standard", "text", "standard", "ref", "image", "standard"]);
  }
});

test("completion preserves exact resource names through a language round trip", () => {
  for (const name of ["Énergie : été ☀", "<img src=x onerror=alert(1)>", 'Code "clair" & sombre', "C:\\cours\\", "e\u0301quation", "x".repeat(120)]) {
    const source = "Bonjour. {Ref: ";
    const trigger = referenceTrigger(source, source.length);
    const completed = completeReference(source, trigger, name)!;
    assert.ok(completed);
    const script = parseAvatarScript(completed.value + " Voici. {} Au revoir.");
    assert.equal(script.sequences[1].content, name);
    assert.equal(script.narration, "Bonjour. Voici. Au revoir.");
  }
});

test("a stale scenario or invalid resource name cannot be completed", () => {
  const source = "Avant. {Ref:";
  const trigger = referenceTrigger(source, source.length);
  assert.ok(trigger);
  assert.equal(completeReference(source + " Nouveau texte.", trigger, "Fond"), null);
  assert.equal(completeReference(source, null, "Fond"), null);
  for (const name of ["", " ", " Nom", "Nom ", "{Texte:injecté}", "ligne\n2", "nul\0", "x".repeat(121), undefined]) {
    assert.equal(completeReference(source, trigger, name), null);
  }
  assert.equal(trigger.source, source);
});
