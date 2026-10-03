"use client";

import { useActiveApp } from "client/hud/appselect/use-active-app";
import styled from "client/styled";

import { QuestionIconView } from "./question-icons";
import { quickActions } from "shared/apps/question-catalog";

const Wrap = styled.section`
  display: flex;
  flex-direction: column;
  gap: var(--gap-m);
  margin: auto 0;
  padding: var(--gap-s) 0;
`;

const Title = styled.header`
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-align: center;

  h2 {
    margin: 0;
    font: 600 var(--font-m, 16px) / 1.25 var(--font-ui);
    letter-spacing: -0.01em;
    color: var(--text);
  }
  p {
    margin: 0;
    color: var(--muted);
    font: 400 var(--font-xs) / 1.45 var(--font-ui);
    text-wrap: balance;
  }
`;

const Grid = styled.div`
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--gap-s);
`;

const Card = styled.button`
  display: grid;
  grid-template-columns: 30px 1fr;
  align-items: center;
  column-gap: var(--gap-m);
  padding: 10px var(--gap-m);
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  box-shadow: var(--shadow);
  background: color-mix(in oklab, var(--surface-2) 70%, transparent);
  color: var(--text);
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s,
    transform 0.15s;

  &:hover:not(:disabled),
  &:focus-visible {
    border-color: var(--accent);
    background: color-mix(in oklab, var(--accent) 12%, var(--surface-2));
    transform: translateY(-1px);
  }
  &:disabled {
    opacity: 0.6;
    cursor: default;
  }
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    transition: none;
    &:hover:not(:disabled) {
      transform: none;
    }
  }

  .icon {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 9px;
    background: color-mix(in oklab, var(--accent) 16%, transparent);
    color: var(--accent);
    font-size: 16px;
  }
  small {
    display: block;
    color: var(--muted);
    font: 600 10.5px / 1.2 var(--font-mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  span {
    display: block;
    margin-top: 2px;
    font: 500 var(--font-s) / 1.35 var(--font-ui);
  }
`;

/** The empty chat: a line on what to ask, and one scoped question per topic as a card. */
export default function QuickStart({ asking, onAsk, onMore }: { asking: boolean; onAsk: (question: string) => void; onMore?: () => void }) {
  const app = useActiveApp();
  const name = app.taxa[0]?.name;
  const subject = name ? (/(fish|carp)$/i.test(name) ? name : `${name}s`) : "Asian carp";
  return (
    <Wrap data-quick-start="" aria-label="Suggested questions">
      <Title>
        <h2>Ask about {subject}</h2>
        <p>
          Sightings, conditions, data sources and the timeline for {app.regions[0]?.name ?? "this area"}. Answers cite their data and move the map.
          {onMore ? (
            <>
              {" "}
              <a
                href="#questions"
                onClick={(event) => {
                  event.preventDefault();
                  onMore();
                }}
              >
                See everything you can ask
              </a>
              .
            </>
          ) : null}
        </p>
      </Title>
      <Grid data-helper-questions="">
        {quickActions(app).map(({ group, question }) => (
          <Card key={group.id} type="button" data-example-question="" disabled={asking} onClick={() => onAsk(question)}>
            <i className="icon">
              <QuestionIconView name={group.icon} />
            </i>
            <div>
              <small>{group.label}</small>
              <span>{question}</span>
            </div>
          </Card>
        ))}
      </Grid>
    </Wrap>
  );
}
