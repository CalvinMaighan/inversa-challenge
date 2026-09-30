import {
  ActiveState,
  key,
  useActiveState,
} from "active-state/react";
import { StrictMode, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";

type Card = { id: string; title: string };
type Column = { id: string; title: string; cards: Card[] };
type Board = { columns: Column[] };
type Theme = { dark: boolean };

const transparentDragPixel = new Image();
transparentDragPixel.src =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const BOARD_SEED: Board = {
  columns: [
    {
      id: "todo",
      title: "To do",
      cards: [
        { id: "c1", title: "Publish active-state" },
        { id: "c2", title: "Write CDN docs" },
      ],
    },
    {
      id: "doing",
      title: "Doing",
      cards: [{ id: "c3", title: "Polish examples" }],
    },
    {
      id: "done",
      title: "Done",
      cards: [{ id: "c4", title: "Name the package" }],
    },
  ],
};

const BOARD = key("BOARD", BOARD_SEED, { persist: true });
const THEME = key("THEME", { dark: true }, { persist: true });

function cloneBoard(board: Board = BOARD_SEED): Board {
  return structuredClone(board);
}

function moveCard(
  board: Board,
  cardId: string,
  toColumnId: string,
  toIndex = 0,
): Board {
  const next = cloneBoard(board);
  let card: Card | undefined;
  for (const col of next.columns) {
    const index = col.cards.findIndex((c) => c.id === cardId);
    if (index !== -1) {
      [card] = col.cards.splice(index, 1);
      break;
    }
  }
  const toCol = next.columns.find((c) => c.id === toColumnId);
  if (!card || !toCol) return board;
  const idx = Math.max(0, Math.min(toIndex, toCol.cards.length));
  toCol.cards.splice(idx, 0, card);
  return next;
}

function addCard(board: Board, columnId: string, title: string): Board {
  const trimmed = title.trim();
  if (!trimmed) return board;
  const next = cloneBoard(board);
  const col = next.columns.find((c) => c.id === columnId);
  if (!col) return board;
  col.cards.unshift({
    id: `c_${Date.now().toString(36)}`,
    title: trimmed,
  });
  return next;
}

function App() {
  const [board, setBoard] = useActiveState<Board>(BOARD);
  const [theme, setTheme] = useActiveState<Theme>(THEME);
  const [dragCardId, setDragCardId] = useState<string | null>(null);
  const [overColumnId, setOverColumnId] = useState<string | null>(null);

  useEffect(() => {
    const apply = () => {
      document.documentElement.dataset.theme = theme?.dark ? "dark" : "light";
    };
    if (document.startViewTransition) document.startViewTransition(apply);
    else apply();
  }, [theme?.dark]);

  if (!board) return null;

  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>active-state — React</h1>
          <p className="lede">
            One file: <code>key()</code>, <code>useActiveState</code>, and the
            kanban UI. Same <code>BOARD</code> / <code>THEME</code> shape as the
            HTML example.
          </p>
        </div>
        <div className="actions">
          <button
            type="button"
            onClick={() => {
              setBoard(cloneBoard(BOARD.defaults));
              setTheme({ ...THEME.defaults });
            }}
          >
            Reset
          </button>
          <button
            type="button"
            onClick={() => setTheme((t) => ({ dark: !t?.dark }))}
          >
            Theme
          </button>
        </div>
      </header>

      <div className="board">
        {board.columns.map((col) => (
          <details
            key={col.id}
            className={`column${overColumnId === col.id ? " drag-over" : ""}`}
            data-column-id={col.id}
            ref={(node) => {
              // Uncontrolled open: start expanded once, keep user toggle across paints.
              if (node && !node.hasAttribute("data-ready")) {
                node.open = true;
                node.setAttribute("data-ready", "");
              }
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setOverColumnId(col.id);
            }}
            onDragLeave={() => {
              setOverColumnId((id) => (id === col.id ? null : id));
            }}
            onDrop={(event) => {
              event.preventDefault();
              setOverColumnId(null);
              const cardId =
                dragCardId || event.dataTransfer.getData("text/plain");
              if (!cardId) return;
              const over = (event.target as HTMLElement).closest(
                "[data-card-id]",
              ) as HTMLElement | null;
              let toIndex = col.cards.length;
              if (over?.dataset.cardId && over.dataset.cardId !== cardId) {
                const idx = col.cards.findIndex(
                  (c) => c.id === over.dataset.cardId,
                );
                if (idx >= 0) toIndex = idx;
              }
              setBoard((b) => moveCard(b!, cardId, col.id, toIndex));
              setDragCardId(null);
            }}
          >
            <summary className="column-head">
              <h2>{col.title}</h2>
              <span className="count">{col.cards.length}</span>
            </summary>
            <div className="cards">
              {col.cards.map((card) => (
                <article
                  key={card.id}
                  className={`card${dragCardId === card.id ? " dragging" : ""}`}
                  draggable
                  data-card-id={card.id}
                  onDragStart={(event) => {
                    const el = event.currentTarget;
                    const rect = el.getBoundingClientRect();
                    const ox = event.clientX - (rect.left + rect.width / 2);
                    const tilt = Math.max(-14, Math.min(14, ox / 6));
                    const offsetX = event.clientX - rect.left;
                    const offsetY = event.clientY - rect.top;
                    event.dataTransfer.setData("text/plain", card.id);
                    event.dataTransfer.effectAllowed = "move";

                    document.querySelectorAll(".drag-ghost").forEach((n) => n.remove());
                    const ghost = el.cloneNode(true) as HTMLElement;
                    ghost.classList.remove("dragging");
                    ghost.classList.add("drag-ghost");
                    ghost.setAttribute("aria-hidden", "true");
                    Object.assign(ghost.style, {
                      position: "fixed",
                      top: "0",
                      left: "0",
                      width: `${Math.max(rect.width, 1)}px`,
                      height: `${Math.max(rect.height, 1)}px`,
                      margin: "0",
                      boxSizing: "border-box",
                      transformOrigin: "center center",
                      pointerEvents: "none",
                      zIndex: "10000",
                      transition: "none",
                    });
                    const place = (x: number, y: number) => {
                      ghost.style.transform = `translate(${x - offsetX}px, ${y - offsetY}px) rotate(${tilt}deg) scale(1.06)`;
                    };
                    place(event.clientX, event.clientY);
                    document.body.appendChild(ghost);

                    event.dataTransfer.setDragImage(transparentDragPixel, 0, 0);

                    const onDragOver = (e: DragEvent) => {
                      if (e.clientX === 0 && e.clientY === 0) return;
                      place(e.clientX, e.clientY);
                    };
                    document.addEventListener("dragover", onDragOver, true);
                    el.dataset.ghostCleanup = "1";
                    const cleanup = () => {
                      document.removeEventListener("dragover", onDragOver, true);
                      ghost.remove();
                    };
                    el.addEventListener("dragend", cleanup, { once: true });
                    document.addEventListener("drop", cleanup, {
                      once: true,
                      capture: true,
                    });

                    setDragCardId(card.id);
                    document.documentElement.classList.add("is-dragging");
                  }}
                  onDragEnd={() => {
                    document.documentElement.classList.remove("is-dragging");
                    setDragCardId(null);
                    setOverColumnId(null);
                  }}
                >
                  <p className="card-title">{card.title}</p>
                </article>
              ))}
            </div>
            <form
              className="add"
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                const form = event.currentTarget;
                const input = form.elements.namedItem(
                  "title",
                ) as HTMLInputElement;
                setBoard((b) => addCard(b!, col.id, input.value));
                input.value = "";
              }}
            >
              <input name="title" placeholder="Add card…" autoComplete="off" />
              <button className="primary" type="submit">
                Add
              </button>
            </form>
          </details>
        ))}
      </div>

      <p className="footnote">
        Everything lives in <code>src/main.tsx</code>.
      </p>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ActiveState init={ActiveState.state} />
    <App />
  </StrictMode>,
);

