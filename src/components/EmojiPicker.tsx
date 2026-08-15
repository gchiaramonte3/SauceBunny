import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Self-contained emoji picker for the review composer. Renders a monochrome
 * smiley tool button (matching the pencil/mic glyphs) and, on click, a
 * fixed-position popover of native emoji. macOS renders these as Apple Color
 * Emoji automatically — no font or dependency needed. The popover is
 * `position: fixed` (anchored to the trigger) so it escapes the panel's
 * overflow clipping, and stays open for multi-insert until Esc / outside-click.
 */

type Entry = [string, string]; // [char, search keywords]

const CATEGORIES: { label: string; items: Entry[] }[] = [
  {
    label: "Smileys",
    items: [
      ["😀", "grinning happy"], ["😃", "smiley happy"], ["😄", "happy laugh"],
      ["😁", "beaming grin"], ["😆", "laughing"], ["😅", "sweat smile"],
      ["🤣", "rofl rolling laughing"], ["😂", "joy tears laughing"],
      ["🙂", "slight smile"], ["🙃", "upside down silly"], ["😉", "wink"],
      ["😊", "blush smile"], ["😇", "innocent halo angel"], ["🥰", "love hearts adore"],
      ["😍", "heart eyes love"], ["🤩", "star struck amazed"], ["😘", "kiss"],
      ["😋", "yum tasty"], ["😜", "wink tongue"], ["🤪", "zany goofy"],
      ["🤔", "thinking hmm"], ["🤨", "raised eyebrow skeptical"], ["😐", "neutral meh"],
      ["🙄", "eye roll"], ["😏", "smirk"], ["😬", "grimace awkward"],
      ["😴", "sleeping tired"], ["🤯", "mind blown exploding head"], ["🥳", "party celebrate"],
      ["😎", "sunglasses cool"], ["🤓", "nerd"], ["🧐", "monocle inspect"],
      ["😕", "confused"], ["🙁", "frown sad"], ["😮", "surprised wow open mouth"],
      ["😢", "cry sad"], ["😭", "sob crying bawling"], ["😤", "triumph steam frustrated"],
      ["😠", "angry mad"], ["😡", "rage furious"], ["🤬", "swearing cursing"],
      ["😳", "flushed embarrassed"], ["🥺", "pleading puppy eyes"], ["😱", "scream fear shock"],
      ["🤗", "hug"], ["🤭", "hand over mouth giggle"], ["🤫", "shush quiet"],
      ["🫡", "salute respect"], ["🫠", "melting"], ["🥲", "happy tears"],
      ["😶", "no mouth speechless"], ["🫥", "dotted invisible"], ["🤐", "zipper mouth"],
    ],
  },
  {
    label: "Gestures",
    items: [
      ["👍", "thumbs up like yes approve good"], ["👎", "thumbs down no dislike bad"],
      ["👏", "clap applause"], ["🙌", "raised hands praise hooray"], ["🙏", "pray thanks please"],
      ["🤝", "handshake deal agree"], ["✌️", "peace victory"], ["🤞", "fingers crossed luck"],
      ["🤟", "love you"], ["🤘", "rock horns"], ["👌", "ok perfect"], ["🤌", "pinched italian"],
      ["🤏", "pinch small tiny"], ["👈", "point left"], ["👉", "point right"],
      ["👆", "point up"], ["👇", "point down"], ["☝️", "index up one"],
      ["✋", "raised hand stop high five"], ["🖐️", "hand"], ["👋", "wave hi bye hello"],
      ["🤙", "call me hang loose"], ["💪", "muscle strong flex"], ["🙋", "raising hand question"],
      ["🤦", "facepalm"], ["🤷", "shrug dunno"], ["🫶", "heart hands love"],
      ["👀", "eyes look watching"], ["🧠", "brain smart"], ["🔥", "fire lit hot"],
      ["💯", "hundred perfect score"], ["✨", "sparkles shiny magic"], ["💀", "skull dead dying"],
    ],
  },
  {
    label: "Hearts & symbols",
    items: [
      ["❤️", "red heart love"], ["🧡", "orange heart"], ["💛", "yellow heart"],
      ["💚", "green heart"], ["💙", "blue heart"], ["💜", "purple heart"],
      ["🖤", "black heart"], ["🤍", "white heart"], ["💔", "broken heart"],
      ["💕", "two hearts"], ["💖", "sparkling heart"], ["💗", "growing heart"],
      ["💘", "cupid arrow heart"], ["💝", "heart gift"], ["⭐", "star"],
      ["🌟", "glowing star"], ["⚡", "zap lightning bolt"], ["💥", "boom collision impact"],
      ["💫", "dizzy stars"], ["✅", "check yes done complete tick"], ["❌", "cross no wrong fail"],
      ["❗", "exclamation important"], ["❓", "question"], ["⚠️", "warning caution"],
      ["🚀", "rocket launch ship fast"], ["🎉", "party tada celebrate"], ["🎊", "confetti celebrate"],
      ["🏆", "trophy win champion"], ["🥇", "gold medal first"], ["👑", "crown king queen"],
      ["💎", "gem diamond"], ["🔔", "bell notification"], ["💬", "speech comment chat"],
      ["💭", "thought bubble"], ["🆗", "ok"], ["🆕", "new"],
    ],
  },
  {
    label: "Animals & nature",
    items: [
      ["🐶", "dog puppy"], ["🐱", "cat"], ["🐭", "mouse"], ["🐹", "hamster"],
      ["🐰", "rabbit bunny"], ["🦊", "fox"], ["🐻", "bear"], ["🐼", "panda"],
      ["🐨", "koala"], ["🐯", "tiger"], ["🦁", "lion"], ["🐮", "cow"],
      ["🐷", "pig"], ["🐸", "frog"], ["🐵", "monkey"], ["🐔", "chicken"],
      ["🐧", "penguin"], ["🐦", "bird"], ["🦉", "owl"], ["🦄", "unicorn"],
      ["🐝", "bee"], ["🦋", "butterfly"], ["🐢", "turtle"], ["🐙", "octopus"],
      ["🐬", "dolphin"], ["🐳", "whale"], ["🌵", "cactus"], ["🌲", "tree evergreen"],
      ["🌴", "palm tree"], ["🌸", "blossom flower"], ["🌹", "rose flower"], ["🌻", "sunflower"],
      ["🌈", "rainbow"], ["☀️", "sun sunny"], ["☁️", "cloud"], ["🌙", "moon night"],
      ["💧", "droplet water"], ["🌊", "wave ocean sea"],
    ],
  },
  {
    label: "Food & drink",
    items: [
      ["🍎", "apple"], ["🍊", "orange"], ["🍋", "lemon"], ["🍌", "banana"],
      ["🍉", "watermelon"], ["🍇", "grapes"], ["🍓", "strawberry"], ["🍒", "cherries"],
      ["🍑", "peach"], ["🥭", "mango"], ["🍍", "pineapple"], ["🥝", "kiwi"],
      ["🍅", "tomato"], ["🥑", "avocado"], ["🌽", "corn"], ["🌶️", "hot pepper spicy chili"],
      ["🥕", "carrot"], ["🍔", "burger hamburger"], ["🍟", "fries"], ["🍕", "pizza"],
      ["🌮", "taco"], ["🌯", "burrito"], ["🍿", "popcorn"], ["🥓", "bacon"],
      ["🍳", "egg fried"], ["🥞", "pancakes"], ["🧀", "cheese"], ["🍗", "chicken leg"],
      ["🍰", "cake slice"], ["🎂", "birthday cake"], ["🍪", "cookie"], ["🍩", "donut"],
      ["🍫", "chocolate"], ["🍭", "lollipop candy"], ["🍦", "ice cream"], ["☕", "coffee"],
      ["🍵", "tea"], ["🍺", "beer"], ["🍻", "cheers beers"], ["🥂", "champagne cheers toast"],
      ["🍷", "wine"], ["🍸", "cocktail"],
    ],
  },
  {
    label: "Activity & travel",
    items: [
      ["⚽", "soccer football"], ["🏀", "basketball"], ["🏈", "football"], ["⚾", "baseball"],
      ["🎾", "tennis"], ["🏐", "volleyball"], ["🎱", "pool eight ball"], ["🏓", "ping pong"],
      ["🥊", "boxing"], ["⛳", "golf"], ["🎯", "dart target bullseye goal"], ["🎮", "game controller gaming"],
      ["🎲", "dice"], ["🎸", "guitar"], ["🎹", "piano keyboard"], ["🥁", "drum"],
      ["🎤", "mic karaoke sing"], ["🎧", "headphones"], ["🎬", "clapper movie film action"],
      ["🎥", "movie camera film"], ["📷", "camera photo"], ["📸", "camera flash"],
      ["🎨", "art palette paint"], ["✈️", "plane flight travel"], ["🚗", "car"],
      ["🚕", "taxi"], ["🏎️", "race car fast"], ["🚀", "rocket"], ["⛵", "sailboat"],
      ["🚢", "ship boat"], ["🗺️", "map"], ["🏖️", "beach"], ["🏔️", "mountain"],
      ["🎡", "ferris wheel"], ["🗽", "statue of liberty"],
    ],
  },
  {
    label: "Objects",
    items: [
      ["💻", "laptop computer"], ["🖥️", "desktop computer"], ["⌨️", "keyboard"],
      ["📱", "phone mobile"], ["💡", "idea light bulb"], ["🔦", "flashlight"],
      ["📡", "satellite signal"], ["💾", "disk save floppy"], ["📺", "tv television"],
      ["⏰", "alarm clock time"], ["⏱️", "stopwatch timer"], ["⌛", "hourglass time"],
      ["🔒", "lock secure"], ["🔓", "unlock"], ["🔑", "key"], ["🔨", "hammer"],
      ["🛠️", "tools"], ["🔧", "wrench fix"], ["⚙️", "gear settings cog"], ["🧪", "test tube experiment"],
      ["🔬", "microscope"], ["🔭", "telescope"], ["📊", "bar chart data"], ["📈", "chart up trending growth"],
      ["📉", "chart down declining"], ["📌", "pin"], ["📎", "paperclip attach"], ["✂️", "scissors cut"],
      ["📝", "memo note write"], ["📁", "folder"], ["📦", "package box ship"], ["📅", "calendar date"],
      ["📖", "book read"], ["💰", "money bag"], ["💵", "dollar money cash"], ["💳", "credit card"],
      ["🔍", "search magnify find"], ["🔗", "link chain"], ["🏷️", "tag label"],
    ],
  },
  {
    label: "Symbols",
    items: [
      ["✔️", "check tick done"], ["☑️", "checkbox checked"], ["🚫", "prohibited no banned"],
      ["⛔", "no entry stop"], ["‼️", "double exclamation"], ["⁉️", "exclamation question"],
      ["🔴", "red circle dot record"], ["🟠", "orange circle"], ["🟡", "yellow circle"],
      ["🟢", "green circle online ok"], ["🔵", "blue circle"], ["🟣", "purple circle"],
      ["⚫", "black circle"], ["⚪", "white circle"], ["🟥", "red square"],
      ["🟩", "green square"], ["🟦", "blue square"], ["▶️", "play"], ["⏸️", "pause"],
      ["⏹️", "stop"], ["⏭️", "next skip"], ["⏮️", "previous back"], ["🔀", "shuffle random"],
      ["🔁", "repeat loop"], ["➕", "plus add"], ["➖", "minus subtract"], ["✖️", "multiply times"],
      ["♾️", "infinity forever"], ["💲", "dollar sign money"], ["#️⃣", "hashtag number"],
      ["✳️", "asterisk"], ["❇️", "sparkle"], ["〽️", "part mark"], ["🆒", "cool"],
      ["🆓", "free"], ["🆙", "up"],
    ],
  },
];

const ALL: Entry[] = CATEGORIES.flatMap((c) => c.items);
const RECENTS_KEY = "saucebunny.review.emoji-recents";
const POP_WIDTH = 324;

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string").slice(0, 24) : [];
  } catch {
    return [];
  }
}

export function EmojiPicker({ onPick, title = "Add emoji" }: { onPick: (emoji: string) => void; title?: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState<string[]>(loadRecents);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Anchor the fixed popover just above the trigger, clamped to the viewport.
  const place = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - POP_WIDTH - 8));
    setPos({ left, bottom: window.innerHeight - r.top + 8 });
  };

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onResize = () => place();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); setQuery(""); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const pick = (emoji: string) => {
    onPick(emoji);
    // Computed and persisted OUTSIDE the updater. React may run an updater
    // more than once - StrictMode does, and a discarded concurrent render can
    // too - so a write in there persists a pick that may never commit.
    const next = [emoji, ...recents.filter((e) => e !== emoji)].slice(0, 24);
    try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    setRecents(next);
  };

  const q = query.trim().toLowerCase();
  const results = q ? ALL.filter(([c, n]) => n.includes(q) || c === query) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={"cp-review-tool" + (open ? " active" : "")}
        onClick={() => setOpen((o) => !o)}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <SmileyGlyph />
      </button>

      {open && pos && (
        <div
          ref={popRef}
          className="cp-emoji-pop"
          role="dialog"
          aria-label="Emoji picker"
          style={{ left: pos.left, bottom: pos.bottom }}
        >
          <div className="cp-emoji-head">
            <SearchGlyph />
            <input
              className="cp-emoji-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search emoji…"
              autoFocus
              spellCheck={false}
              aria-label="Search emoji"
            />
          </div>

          <div className="cp-emoji-body">
            {results ? (
              results.length ? (
                <div className="cp-emoji-grid" role="listbox" aria-label="Search results">
                  {results.map(([c, n]) => (
                    <button key={c} type="button" className="cp-emoji-cell" onClick={() => pick(c)} title={n} aria-label={n}>{c}</button>
                  ))}
                </div>
              ) : (
                <div className="cp-emoji-empty">No emoji for “{query}”.</div>
              )
            ) : (
              <>
                {recents.length > 0 && (
                  <section className="cp-emoji-sect">
                    <h4 className="cp-emoji-label">Recent</h4>
                    <div className="cp-emoji-grid">
                      {recents.map((c) => (
                        <button key={"r-" + c} type="button" className="cp-emoji-cell" onClick={() => pick(c)} aria-label={c}>{c}</button>
                      ))}
                    </div>
                  </section>
                )}
                {CATEGORIES.map((cat) => (
                  <section className="cp-emoji-sect" key={cat.label}>
                    <h4 className="cp-emoji-label">{cat.label}</h4>
                    <div className="cp-emoji-grid">
                      {cat.items.map(([c, n]) => (
                        <button key={c} type="button" className="cp-emoji-cell" onClick={() => pick(c)} title={n} aria-label={n}>{c}</button>
                      ))}
                    </div>
                  </section>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function SmileyGlyph() {
  return (
    <svg className="cp-review-glyph" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9.25" />
      <path d="M8.2 14.2a4.4 4.4 0 0 0 7.6 0" />
      <path d="M9 9.4h.01M15 9.4h.01" />
    </svg>
  );
}

function SearchGlyph() {
  return (
    <svg className="cp-emoji-searchicon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" />
    </svg>
  );
}
