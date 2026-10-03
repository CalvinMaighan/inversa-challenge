"use client";

import { useActiveApp } from "client/hud/appselect/use-active-app";
import styled from "client/styled";

import { QuestionIconView } from "./question-icons";
import { questionGroups } from "shared/apps/question-catalog";

const Scroll = styled.div`
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--gap-l, 18px);
  padding: var(--gap-m);
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
`;

const Lead = styled.p`
  margin: 0;
  color: var(--muted);
  font: 400 var(--font-xs) / 1.5 var(--font-ui);
`;

const Group = styled.section`
  display: flex;
  flex-direction: column;
  gap: var(--gap-s);

  header {
    display: grid;
    grid-template-columns: 28px 1fr;
    align-items: center;
    column-gap: var(--gap-m);
  }
  .icon {
    display: grid;
    place-items: center;
    grid-row: 1 / 3;
    width: 28px;
    height: 28px;
    border-radius: 8px;
    background: color-mix(in oklab, var(--accent) 16%, transparent);
    color: var(--accent);
    font-size: 15px;
  }
  h3 {
    margin: 0;
    font: 600 var(--font-s) / 1.25 var(--font-ui);
  }
  header p {
    margin: 0;
    color: var(--muted);
    font: 400 11.5px / 1.35 var(--font-ui);
  }
  ul {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 0;
    padding: 0 0 0 calc(28px + var(--gap-m));
    list-style: none;
  }
`;

const Ask = styled.button`
  width: 100%;
  padding: 7px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-s);
  box-shadow: var(--shadow);
  background: color-mix(in oklab, var(--surface-2) 60%, transparent);
  color: var(--text);
  font: 400 var(--font-xs) / 1.4 var(--font-ui);
  text-align: left;
  cursor: pointer;

  &:hover:not(:disabled),
  &:focus-visible {
    border-color: var(--accent);
    background: color-mix(in oklab, var(--accent) 12%, var(--surface-2));
  }
  &:disabled {
    opacity: 0.6;
    cursor: default;
  }
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
`;

/** The Questions tab: everything the agent can be asked or told to do, by topic. A click asks it in the Agent tab. */
export default function QuestionsPanel({ asking, onAsk }: { asking: boolean; onAsk: (question: string) => void }) {
  const app = useActiveApp();
  return (
    <Scroll data-questions-panel="">
      <Lead>Type these, tap one, or tap the microphone and say them. The agent answers only about the species and places on this map, with its sources, and can move the map for you.</Lead>
      {questionGroups(app).map((group) => (
        <Group key={group.id} data-question-group={group.id}>
          <header>
            <i className="icon">
              <QuestionIconView name={group.icon} />
            </i>
            <h3>{group.label}</h3>
            <p>{group.hint}</p>
          </header>
          <ul>
            {group.questions.map((q) => (
              <li key={q}>
                <Ask type="button" disabled={asking} onClick={() => onAsk(q)}>
                  {q}
                </Ask>
              </li>
            ))}
          </ul>
        </Group>
      ))}
    </Scroll>
  );
}
