"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { clientGet } from "@/lib/api";

// The command palette: one field that finds a company or an agency and opens
// its constellation, or jumps to a view. It opens from the button in the top
// bar or with Cmd+K (Ctrl+K elsewhere), on every page. A native <dialog> holds
// it, so focus is trapped while it is open and Escape closes it.

type Hit = { id: number; name: string; kind: "company" | "agency" | "office"; uei: string | null };
type Item = { key: string; label: string; hint: string; href: string };

const PLACES: Item[] = [
  { key: "flow", label: "Flow", hint: "Who pays whom", href: "/graph" },
  {
    key: "constellation",
    label: "Constellation",
    hint: "One company's neighborhood",
    href: "/graph?view=constellation",
  },
  { key: "timeline", label: "Timeline", hint: "What changed and when", href: "/graph?view=timeline" },
  { key: "forum", label: "Forum", hint: "The signals dashboard", href: "/forum" },
  { key: "report", label: "Field Report", hint: "The week in prose", href: "/feed" },
  { key: "numbers", label: "How the numbers are counted", hint: "Definitions", href: "/about/numbers" },
];
const KIND: Record<Hit["kind"], string> = { company: "Company", agency: "Agency", office: "Office" };

export function CommandPalette() {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState(0);
  const [mac, setMac] = useState(true);
  const listId = useId();

  useEffect(() => {
    setMac(/Mac|iPhone|iPad/.test(navigator.platform));
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      input.current?.focus();
    } else if (!open && d.open) d.close();
  }, [open]);

  // Search as the reader types, a beat after they pause.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setHits([]);
      setBusy(false);
      return;
    }
    const ctl = new AbortController();
    setBusy(true);
    const t = setTimeout(() => {
      clientGet<Hit[]>(`search?q=${encodeURIComponent(term)}`, ctl.signal)
        .then((r) => {
          setHits(r);
          setBusy(false);
        })
        .catch(() => {
          if (!ctl.signal.aborted) setBusy(false);
        });
    }, 140);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q]);

  const term = q.trim().toLowerCase();
  const places = term ? PLACES.filter((p) => p.label.toLowerCase().includes(term)) : PLACES;
  const items: Item[] = [
    ...hits.map((h) => ({
      key: `org:${h.id}`,
      label: h.name,
      hint: KIND[h.kind],
      href: `/graph?focus=${encodeURIComponent(`org:${h.id}`)}`,
    })),
    ...places,
  ];
  const active = Math.min(at, Math.max(0, items.length - 1));

  const go = (item: Item | undefined) => {
    if (!item) return;
    setOpen(false);
    setQ("");
    router.push(item.href);
  };

  return (
    <>
      <button
        type="button"
        className="cmdk-button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label="Find a company or agency"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </svg>
        <span className="cmdk-button-text">Find a company or agency</span>
        <kbd className="cmdk-kbd">{mac ? "⌘K" : "Ctrl K"}</kbd>
      </button>
      <dialog
        ref={dialog}
        className="cmdk"
        aria-label="Find a company, an agency or a view"
        onClose={() => setOpen(false)}
        onClick={(e) => {
          if (e.target === dialog.current) setOpen(false); // the backdrop
        }}
      >
        <div className="cmdk-box">
          <input
            ref={input}
            type="search"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={items[active] ? `${listId}-${active}` : undefined}
            aria-label="Find a company or agency"
            placeholder="Find a company or agency"
            autoComplete="off"
            spellCheck={false}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setAt(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setAt((active + 1) % Math.max(1, items.length));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setAt((active - 1 + items.length) % Math.max(1, items.length));
              } else if (e.key === "Enter") {
                e.preventDefault();
                go(items[active]);
              }
            }}
          />
          <ul id={listId} role="listbox" aria-label="Results">
            {hits.length > 0 && (
              <li role="presentation" className="cmdk-group">
                Companies and agencies
              </li>
            )}
            {items.map((item, i) => (
              <li key={item.key} role="presentation">
                {i === hits.length && <span className="cmdk-group">Go to</span>}
                <button
                  type="button"
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  tabIndex={-1}
                  className="cmdk-item"
                  onPointerMove={() => setAt(i)}
                  onClick={() => go(item)}
                >
                  <span>{item.label}</span>
                  <span className="cmdk-hint">{item.hint}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="cmdk-status" role="status">
            {term.length >= 2 && !busy && hits.length === 0
              ? "No company or agency by that name."
              : busy
                ? "Searching…"
                : "↑ ↓ to move · Enter to open · Esc to close"}
          </p>
        </div>
      </dialog>
    </>
  );
}
