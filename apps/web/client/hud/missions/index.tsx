"use client";

/**
 * Missions panel (PRD §3 flow 4, PLAN.md C16 slot): plan a mission from the selected hotspot cell, move it
 * planned → in progress → done, log removals, read totals per species, leave notes, chat with the team and
 * see who is on the board. Renders from the db worker's board (`team.ts`); every control is a native
 * button, select or input, so it works from the keyboard and inside T18's bottom sheet on phones.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { set } from "@calvinjs/active-state";
import { useActiveState } from "@calvinjs/active-state/react";

import { SPECIES_IDS } from "shared/voice/ui-tools";

import { getGlobe } from "client/globe/api";
import { ME, type MeState } from "client/state/me";
import { MISSIONS, type MissionsState } from "client/state/missions";
import { PEERS, type Peer } from "client/state/peers";
import { SELECTION, type SelectionState } from "client/state/selection";
import styled from "client/styled";

import { parseHotspotId, type HotspotRef } from "../drawer/evidence";
import { Dot, IconButton, Mono, Pill, SectionTitle, type Tone } from "../primitives";
import { useCell } from "../store";
import {
  bumpCounter,
  createMissionOps,
  createNoteOps,
  deleteMissionOp,
  formFromHotspot,
  isMissionStatus,
  MAX_BODY_CHARS,
  memoryCounterStore,
  messageOp,
  MISSION_STATUSES,
  missionFieldsFromForm,
  removalOp,
  setStatusOp,
  validateMissionForm,
  type BoardModel,
  type CounterStore,
  type FormErrors,
  type Mission,
  type MissionForm,
  type MissionStatus,
} from "./board";
import { callsignOf, ensureTeam, teamCell, type Team } from "./team";

/** Camera height when a mission is focused: the cell and its neighbours. */
const FOCUS_ALTITUDE_M = 12_000;

const Stack = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--gap-m);
  font-size: 13px;
`;

const Section = styled.section`
  display: flex;
  flex-direction: column;
  gap: var(--gap-s);
`;

const Row = styled.div`
  display: flex;
  align-items: center;
  gap: var(--gap-s);
  flex-wrap: wrap;
`;

const Field = styled.label`
  display: flex;
  flex-direction: column;
  gap: 3px;
  font: 600 10px / 1.2 var(--font-mono);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
`;

const control = `
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: color-mix(in oklch, var(--surface) 60%, transparent);
  color: var(--text);
  font: 13px var(--font-ui);
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
`;

const Input = styled.input`
  ${control}
`;

const Select = styled.select`
  ${control}
`;

const ErrorText = styled.span`
  color: var(--danger);
  font: 11px var(--font-ui);
  text-transform: none;
  letter-spacing: 0;
`;

const Hint = styled.p`
  margin: 0;
  color: var(--muted);
  font-size: 12px;
`;

const List = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

const MissionRow = styled.li<{ $focused: boolean }>`
  border: 1px solid ${(p) => (p.$focused ? "var(--accent)" : "var(--border)")};
  border-radius: var(--radius-s);
  background: ${(p) => (p.$focused ? "color-mix(in oklch, var(--accent) 10%, transparent)" : "transparent")};
`;

const MissionButton = styled.button`
  display: flex;
  width: 100%;
  align-items: center;
  gap: var(--gap-s);
  padding: 8px;
  border: 0;
  background: transparent;
  color: var(--text);
  text-align: left;
  font: inherit;
  cursor: pointer;
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  strong {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }
`;

const Detail = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--gap-s);
  padding: 0 8px 8px;
  border-top: 1px solid var(--border);
  padding-top: var(--gap-s);
`;

const NoteList = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  li {
    padding: 4px 6px;
    border-left: 2px solid var(--border);
  }
`;

const Chat = styled.ol`
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 180px;
  overflow: auto;
  font-size: 12px;
  li {
    display: flex;
    gap: 6px;
    align-items: baseline;
  }
`;

const Author = styled.span<{ $color: string }>`
  color: ${(p) => p.$color};
  font: 600 11px var(--font-mono);
  white-space: nowrap;
`;

const ChatForm = styled.form`
  display: flex;
  gap: var(--gap-s);
  input {
    flex: 1;
    min-width: 0;
  }
`;

const STATUS_TONE: Record<MissionStatus, Tone> = { planned: "muted", in_progress: "warn", done: "ok" };
const STATUS_LABEL: Record<MissionStatus, string> = { planned: "Planned", in_progress: "In progress", done: "Done" };

function focusMission(m: Mission | null): void {
  set<MissionsState>(MISSIONS, (prev) => ({ ...MISSIONS.defaults, ...prev, focusedMissionId: m?.id ?? null }));
  if (m) getGlobe()?.flyTo({ lon: m.lon, lat: m.lat, altitudeM: FOCUS_ALTITUDE_M });
}

const emptyForm: MissionForm = { title: "", species: SPECIES_IDS[0], cell: "", at: "" };

/**
 * This node's removal totals (PLAN.md C5: the op carries the node's running total). `readBoard` returns merged
 * sums only, so the per-node total lives in localStorage; a blocked store (private mode) falls back to memory
 * for the session. ponytail: two origins for one node id would fork the counter; the merge is per-node max, so
 * the worst case is an undercount, never a double count.
 */
let memoryCounters: CounterStore | null = null;
function counterStore(): CounterStore {
  try {
    const ls = window.localStorage;
    ls.getItem("inversa:removals:probe");
    return ls;
  } catch {
    memoryCounters ??= memoryCounterStore();
    return memoryCounters;
  }
}

/**
 * "Create mission from hotspot": prefilled from the `hotspot:` selection (also what the explain panel shows).
 * Keyed on the selection by its parent, so a new cell mounts a fresh form.
 */
function NewMission({ team, hotspot }: { team: Team; hotspot: HotspotRef | null }) {
  const [form, setForm] = useState<MissionForm>(() => (hotspot ? formFromHotspot(hotspot) : emptyForm));
  const [errors, setErrors] = useState<FormErrors>({});
  const [busy, setBusy] = useState(false);

  if (!hotspot) {
    return (
      <Section aria-label="New mission">
        <SectionTitle>New mission</SectionTitle>
        <Hint data-testid="mission-hint">Select a hotspot cell on the globe to plan a mission from it.</Hint>
      </Section>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs = validateMissionForm(form);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const fields = missionFieldsFromForm(form, team.nodeId);
      const { id, ops } = createMissionOps(team.factory(), fields);
      await team.edit(ops);
      focusMission({ id, ...fields });
      setForm({ ...form, title: formFromHotspot(hotspot).title });
    } catch (err) {
      setErrors({ title: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section as="form" aria-label="New mission" onSubmit={submit} data-testid="mission-form">
      <SectionTitle>New mission from hotspot</SectionTitle>
      <Field>
        Title
        <Input name="title" value={form.title} maxLength={200} onChange={(e) => setForm({ ...form, title: e.target.value })} aria-invalid={Boolean(errors.title)} data-testid="mission-title" />
        {errors.title && <ErrorText role="alert">{errors.title}</ErrorText>}
      </Field>
      <Row>
        <Field>
          Species
          <Select name="species" value={form.species} onChange={(e) => setForm({ ...form, species: e.target.value })} data-testid="mission-species">
            {SPECIES_IDS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
        <Field>
          Cell
          <Mono data-testid="mission-cell">{form.cell}</Mono>
        </Field>
        <Field>
          Frame
          <Mono>{form.at.slice(0, 16).replace("T", " ")}Z</Mono>
        </Field>
      </Row>
      <Row>
        <IconButton type="submit" $active disabled={busy} data-testid="mission-create">
          Create mission
        </IconButton>
      </Row>
    </Section>
  );
}

function MissionItem({ team, mission, model, focused, me, peers }: { team: Team; mission: Mission; model: BoardModel; focused: boolean; me: MeState | undefined; peers: Peer[] }) {
  const [note, setNote] = useState("");
  const removals = model.removals[mission.id] ?? 0;
  const notes = model.notes.filter((n) => n.missionId === mission.id);
  const setStatus = (status: string) => {
    if (isMissionStatus(status)) void team.edit([setStatusOp(team.factory(), mission.id, status)]);
  };
  const logRemoval = () => {
    const total = bumpCounter(counterStore(), team.boardId, team.nodeId, mission.id);
    void team.edit([removalOp(team.factory(), mission.id, total)]);
  };
  const remove = () => {
    void team.edit([deleteMissionOp(team.factory(), mission.id)]);
    if (focused) focusMission(null);
  };
  const addNote = (e: FormEvent) => {
    e.preventDefault();
    const body = note.trim().slice(0, MAX_BODY_CHARS);
    if (!body) return;
    void team.edit(createNoteOps(team.factory(), mission.id, body));
    setNote("");
  };
  return (
    <MissionRow $focused={focused} data-testid="mission-row" data-mission-id={mission.id} data-status={mission.status}>
      <MissionButton type="button" onClick={() => focusMission(focused ? null : mission)} aria-expanded={focused} aria-label={`${mission.title}, ${STATUS_LABEL[mission.status]}, ${removals} removals`}>
        <strong data-testid="mission-name">{mission.title}</strong>
        <Pill $tone={STATUS_TONE[mission.status]} data-testid="mission-status-pill">
          {STATUS_LABEL[mission.status]}
        </Pill>
        <Mono data-testid="removal-total">{removals}</Mono>
      </MissionButton>
      {focused && (
        <Detail>
          <Row>
            <Mono>
              {mission.species} · cell {mission.cell ?? `${mission.lon.toFixed(3)},${mission.lat.toFixed(3)}`}
            </Mono>
            <Mono>{mission.window.from.slice(0, 10)}</Mono>
          </Row>
          <Row>
            <Field>
              Status
              <Select value={mission.status} onChange={(e) => setStatus(e.target.value)} data-testid="mission-status">
                {MISSION_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </Select>
            </Field>
            <IconButton type="button" onClick={logRemoval} data-testid="removal-add">
              +1 removal
            </IconButton>
            <IconButton type="button" onClick={remove} aria-label="Delete mission" data-testid="mission-delete">
              Delete
            </IconButton>
          </Row>
          {notes.length > 0 && (
            <NoteList aria-label="Notes" data-testid="note-list">
              {notes.map((n) => (
                <li key={n.id}>
                  <Author $color="var(--muted)">{callsignOf(n.createdBy, peers, me)}</Author> {n.body}
                </li>
              ))}
            </NoteList>
          )}
          <ChatForm onSubmit={addNote} aria-label="Add note">
            <Input value={note} placeholder="Add a note" maxLength={MAX_BODY_CHARS} onChange={(e) => setNote(e.target.value)} data-testid="note-input" />
            <IconButton type="submit" disabled={!note.trim()} data-testid="note-add">
              Note
            </IconButton>
          </ChatForm>
        </Detail>
      )}
    </MissionRow>
  );
}

function TeamChat({ team, model, me, peers }: { team: Team; model: BoardModel; me: MeState | undefined; peers: Peer[] }) {
  const [draft, setDraft] = useState("");
  const send = (e: FormEvent) => {
    e.preventDefault();
    const body = draft.trim().slice(0, MAX_BODY_CHARS);
    if (!body) return;
    void team.edit([messageOp(team.factory(), body)]);
    setDraft("");
  };
  const colorOf = (nodeId: string) => (me && nodeId === me.nodeId ? me.color : (peers.find((p) => p.peerId === nodeId)?.color ?? "var(--muted)"));
  return (
    <Section aria-label="Team chat">
      <SectionTitle>Team chat</SectionTitle>
      <Chat data-testid="chat-log" aria-live="polite">
        {model.messages.map((m) => (
          <li key={m.id} data-testid="chat-message">
            <Author $color={colorOf(m.nodeId)}>{callsignOf(m.nodeId, peers, me)}</Author>
            <span>{m.body}</span>
          </li>
        ))}
      </Chat>
      <ChatForm onSubmit={send}>
        <Input value={draft} placeholder="Message the team" maxLength={MAX_BODY_CHARS} onChange={(e) => setDraft(e.target.value)} aria-label="Message" data-testid="chat-input" />
        <IconButton type="submit" disabled={!draft.trim()} data-testid="chat-send">
          Send
        </IconButton>
      </ChatForm>
    </Section>
  );
}

const LINK_TONE: Record<Peer["link"], Tone> = { connecting: "warn", open: "ok", relay: "stale", closed: "danger" };
const LINK_LABEL: Record<Peer["link"], string> = { connecting: "connecting", open: "rtc", relay: "server", closed: "gone" };

function Presence({ me, peers }: { me: MeState | undefined; peers: Peer[] }) {
  return (
    <Section aria-label="Presence">
      <SectionTitle>On the board</SectionTitle>
      <List data-testid="presence-list">
        {me && (
          <li>
            <Row>
              <Dot $tone="ok" style={{ background: me.color, boxShadow: `0 0 6px ${me.color}` }} />
              <Mono>{me.callsign}</Mono>
              <Pill $tone="muted">you</Pill>
            </Row>
          </li>
        )}
        {peers.map((p) => (
          <li key={p.peerId} data-testid="presence-peer" data-link={p.link}>
            <Row>
              <Dot $tone="ok" $pulse={p.link === "connecting"} style={{ background: p.color, boxShadow: `0 0 6px ${p.color}` }} />
              <Mono>{p.callsign}</Mono>
              <Pill $tone={LINK_TONE[p.link]}>{LINK_LABEL[p.link]}</Pill>
            </Row>
          </li>
        ))}
      </List>
    </Section>
  );
}

const NO_PEERS: Peer[] = [];

function PanelBody({ team }: { team: Team }) {
  const model = useCell(team.board);
  const me = useActiveState<MeState>(ME)[0];
  const allPeers = useActiveState<Peer[]>(PEERS)[0] ?? NO_PEERS;
  const focusedId = useActiveState<MissionsState, string | null>(MISSIONS, (m) => m.focusedMissionId)[0] ?? null;
  const evidenceId = useActiveState<SelectionState, string | null>(SELECTION, (s) => s.evidenceId)[0] ?? null;
  const hotspot = useMemo(() => (evidenceId ? parseHotspotId(evidenceId) : null), [evidenceId]);
  // Sessions the mesh dropped are removed from PEERS; the TTL sweep belongs to the globe layer's timer.
  const peers = useMemo(() => allPeers.filter((p) => p.link !== "closed").sort((a, b) => a.callsign.localeCompare(b.callsign)), [allPeers]);
  return (
    <Stack data-testid="team-panel" data-ready={model ? "1" : "0"}>
      <Presence me={me} peers={peers} />
      <NewMission key={evidenceId ?? ""} team={team} hotspot={hotspot} />
      <Section aria-label="Totals">
        <SectionTitle>Removals</SectionTitle>
        <Row>
          <Pill $tone="ok">
            total <Mono data-testid="totals-overall">{model?.totals.overall ?? 0}</Mono>
          </Pill>
          {SPECIES_IDS.map((s) => (
            <Pill key={s} $tone="muted" data-testid={`totals-${s}`}>
              {s} <Mono>{model?.totals.bySpecies[s] ?? 0}</Mono>
            </Pill>
          ))}
        </Row>
      </Section>
      <Section aria-label="Missions">
        <SectionTitle>Missions</SectionTitle>
        {model && model.missions.length === 0 && <Hint>No missions yet.</Hint>}
        <List data-testid="mission-list">
          {model?.missions.map((m) => <MissionItem key={m.id} team={team} mission={m} model={model} focused={m.id === focusedId} me={me} peers={peers} />)}
        </List>
      </Section>
      {model && <TeamChat team={team} model={model} me={me} peers={peers} />}
    </Stack>
  );
}

/** The panel content for `Hud`'s `missions` slot (PLAN.md C16). Starts the team session on mount. */
export default function MissionsPanel() {
  const team = useCell(teamCell);
  useEffect(() => {
    try {
      ensureTeam();
    } catch (err) {
      console.error("[missions] team boot failed", err);
    }
  }, []);
  return team ? <PanelBody team={team} /> : <Hint data-testid="team-panel">Joining the board…</Hint>;
}
