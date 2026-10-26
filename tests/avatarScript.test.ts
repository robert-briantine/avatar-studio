import assert from "node:assert/strict";
import test from "node:test";
import { AvatarScriptSyntaxError, hasScriptImages, hasScriptReferences, hasScriptVisuals, parseAvatarScript } from "../src/avatarScript.js";

test("plain narration keeps its text and starts in standard mode", () => {
  const source = "  Bonjour Robert.\nVoici la suite.  ";
  assert.deepEqual(parseAvatarScript(source), {
    source,
    narration: "Bonjour Robert.\nVoici la suite.",
    sequences: [{ mode: "standard", text: "Bonjour Robert.\nVoici la suite." }]
  });
});

test("the Robert example separates the overlay from spoken words and resets the display", () => {
  const source = "{Texte: hello} Je suis Robert. {} Et je viens d’afficher un texte.";
  assert.deepEqual(parseAvatarScript(source), {
    source,
    narration: "Je suis Robert. Et je viens d’afficher un texte.",
    sequences: [
      { mode: "text", content: "hello", text: "Je suis Robert." },
      { mode: "standard", text: "Et je viens d’afficher un texte." }
    ]
  });
});

test("all commands preserve their visual content and the order of narration", () => {
  const script = parseAvatarScript(
    "Début. {Texte: titre} Un. {} Deux. {Latex: x+1} Trois. {} " +
    "{Image: une licorne} Quatre. {} {File:/videos/combat.mp4} Cinq. {} Fin."
  );
  assert.equal(script.narration, "Début. Un. Deux. Trois. Quatre. Cinq. Fin.");
  assert.deepEqual(script.sequences, [
    { mode: "standard", text: "Début." },
    { mode: "text", content: "titre", text: "Un." },
    { mode: "standard", text: "Deux." },
    { mode: "latex", content: "x+1", text: "Trois." },
    { mode: "image", content: "une licorne", text: "Quatre." },
    { mode: "file", content: "/videos/combat.mp4", text: "Cinq." },
    { mode: "standard", text: "Fin." }
  ]);
});

test("LaTeX groups and escaped braces do not end the outer command", () => {
  const formula = String.raw`\frac{x_{1}+1}{\sqrt{y}} + \left\{ z \right.`;
  const script = parseAvatarScript(`{Latex: ${formula}} Une formule. {} Suite.`);
  assert.deepEqual(script.sequences, [
    { mode: "latex", content: formula, text: "Une formule." },
    { mode: "standard", text: "Suite." }
  ]);
  assert.equal(script.narration, "Une formule. Suite.");
});

test("command content may contain additional colons and Unicode", () => {
  const script = parseAvatarScript("{Texte : Énergie : été ☀} Bonjour. {File: C:\\videos\\combat.mp4} Combat.");
  assert.deepEqual(script.sequences, [
    { mode: "text", content: "Énergie : été ☀", text: "Bonjour." },
    { mode: "file", content: "C:\\videos\\combat.mp4", text: "Combat." }
  ]);
});

test("a new command replaces the display and an unclosed display lasts until end of script", () => {
  assert.deepEqual(parseAvatarScript("{Texte: A}Un.{Image: B}Deux.").sequences, [
    { mode: "text", content: "A", text: "Un." },
    { mode: "image", content: "B", text: "Deux." }
  ]);
  assert.equal(parseAvatarScript("Bonjour{Texte: A}Robert").narration, "Bonjour Robert");
});

test("empty narration sections create no sequences and repeated resets are harmless", () => {
  assert.deepEqual(parseAvatarScript("{} { } {Image: licorne} Voici. {} {}"), {
    source: "{} { } {Image: licorne} Voici. {} {}",
    narration: "Voici.",
    sequences: [{ mode: "image", content: "licorne", text: "Voici." }]
  });
  for (const source of ["", "  \n ", "{}", "{} {} { }"]) {
    assert.equal(parseAvatarScript(source).narration, "");
    assert.deepEqual(parseAvatarScript(source).sequences, []);
  }
});

test("visual commands without associated words are rejected at the command position", () => {
  for (const name of ["Texte", "Latex", "Image", "File", "Ref"]) {
    for (const ending of ["", " \n ", " {} Suite.", " {Texte: suivant} Suite."]) {
      assert.throws(() => parseAvatarScript(`Avant. {${name}: contenu}${ending}`), (error: unknown) => {
        assert.ok(error instanceof AvatarScriptSyntaxError);
        assert.equal(error.position, 7);
        assert.match(error.message, /suivie d’un texte/);
        return true;
      });
    }
  }
});

test("named references preserve the exact narration, replace one another and reset like other visuals", () => {
  const source = "Avant. { Ref : Formule : Énergie } La formule. {Ref:Code} Première ligne.\nSuite. {} Retour. {Ref:Schéma} Fin.";
  const script = parseAvatarScript(source);
  assert.equal(script.source, source);
  assert.equal(script.narration, "Avant. La formule. Première ligne.\nSuite. Retour. Fin.");
  assert.deepEqual(script.sequences, [
    { mode: "standard", text: "Avant." }, { mode: "ref", content: "Formule : Énergie", text: "La formule." },
    { mode: "ref", content: "Code", text: "Première ligne.\nSuite." },
    { mode: "standard", text: "Retour." }, { mode: "ref", content: "Schéma", text: "Fin." }
  ]);
  assert.equal(hasScriptReferences(script), true); assert.equal(hasScriptVisuals(script), true); assert.equal(hasScriptImages(script), false);
  assert.throws(() => parseAvatarScript("{Ref: } Bonjour."), /Contenu vide/);
  assert.throws(() => parseAvatarScript("{ref:Nom} Bonjour."), /Commande inconnue/);
  const literal = parseAvatarScript(String.raw`Voici \{Ref:Nom\}.`);
  assert.equal(literal.narration, "Voici {Ref:Nom}."); assert.equal(hasScriptReferences(literal), false);
  assert.equal((parseAvatarScript(String.raw`{Ref:Chemin\\} Bonjour.`).sequences[0] as { content: string }).content, "Chemin\\");
});

test("escaped literal braces and backslashes are spoken without becoming commands", () => {
  const source = String.raw`Affiche \{Texte: hello\}, puis \{ et \}, et \\.`;
  assert.deepEqual(parseAvatarScript(source), {
    source, narration: String.raw`Affiche {Texte: hello}, puis { et }, et \.`,
    sequences: [{ mode: "standard", text: String.raw`Affiche {Texte: hello}, puis { et }, et \.` }]
  });
  const mixed = parseAvatarScript(String.raw`\{exemple\} {Texte: titre} Voici \{x: y\}. {} Fin.`);
  assert.deepEqual(mixed.sequences, [
    { mode: "standard", text: "{exemple}" },
    { mode: "text", content: "titre", text: "Voici {x: y}." },
    { mode: "standard", text: "Fin." }
  ]);
  const slashes = parseAvatarScript(String.raw`\\{Texte: titre} Bonjour.`);
  assert.deepEqual(slashes.sequences, [{ mode: "standard", text: "\\" }, { mode: "text", content: "titre", text: "Bonjour." }]);
  assert.equal(parseAvatarScript(String.raw`C:\temp\photo`).narration, String.raw`C:\temp\photo`);
});

test("invalid commands report their position instead of leaking into the narration", () => {
  const cases: Array<[string, number, RegExp]> = [
    ["Bonjour {Latext: x+1} Suite.", 8, /Commande inconnue/],
    ["{texte: titre} Bonjour.", 0, /Commande inconnue/],
    ["{Texte} Bonjour.", 0, /forme/],
    ["{Texte:   } Bonjour.", 0, /Contenu vide/],
    ["Bonjour {Image: licorne", 8, /sans accolade fermante/],
    ["{Latex: \\frac{x}{y} Formule.", 0, /sans accolade fermante/],
    ["Bonjour }", 8, /Accolade fermante/]
  ];
  for (const [source, position, message] of cases) {
    assert.throws(() => parseAvatarScript(source), (error: unknown) => {
      assert.ok(error instanceof AvatarScriptSyntaxError);
      assert.equal(error.position, position);
      assert.match(error.message, message);
      assert.match(error.message, new RegExp(`caractère ${position + 1}`));
      return true;
    });
  }
});
