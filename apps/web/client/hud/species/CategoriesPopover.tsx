"use client";

import { useState, type RefObject } from "react";

import { setSpeciesVisible, setTaxonVisible, showAllSpecies } from "client/state/layers";
import styled from "client/styled";
import type { CategoryId } from "shared/species-categories";

import { formatCount } from "../legend/model";
import { MOBILE, Mono } from "../primitives";
import { PopoverBox } from "../topbar/TopBar";
import CategoryIcon from "./CategoryIcon";
import type { CategoryRow } from "./model";

const List = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 2px;
  max-height: min(70vh, 520px);
  overflow: auto;
`;

const Row = styled.li`
  display: grid;
  grid-template-columns: auto 1fr auto auto;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 0 4px;
  border-radius: var(--radius-s);

  &:hover {
    background: color-mix(in oklch, var(--text) 6%, transparent);
  }

  label {
    display: contents;
    cursor: pointer;
  }

  input {
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: var(--accent);
    cursor: pointer;
  }

  span.name {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font: 500 12.5px / 1.2 var(--font-ui);
    color: var(--text);
  }

  &[data-off] span.name {
    color: var(--muted);
  }
`;

const Count = styled(Mono)`
  color: var(--muted);
  font-size: 11px;
`;

const Expand = styled.button`
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--muted);
  font: 600 12px / 1 var(--font-ui);
  cursor: pointer;

  &:hover {
    color: var(--text);
    background: color-mix(in oklch, var(--text) 10%, transparent);
  }
  &[aria-expanded="true"] {
    color: var(--text);
  }
`;

const Species = styled.ul`
  list-style: none;
  margin: 0 0 4px 30px;
  padding: 0;
  display: grid;
  gap: 1px;

  ${MOBILE} {
    margin-left: 20px;
  }
`;

const Head = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 0 0 6px;
  font: 400 12px / 1.35 var(--font-ui);
  color: var(--muted);

  button {
    height: 24px;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-s);
    background: transparent;
    color: var(--text);
    font: 600 11.5px / 1 var(--font-ui);
    cursor: pointer;
  }
`;

function CategoryItem({ row, hours }: { row: CategoryRow; hours: string }) {
  const [open, setOpen] = useState(false);
  const canOpen = row.species.length > 0;
  return (
    <>
      <Row data-category-row={row.id} data-off={row.on ? undefined : ""}>
        <label>
          <input type="checkbox" checked={row.on} onChange={(e) => setSpeciesVisible(row.id, e.currentTarget.checked)} data-testid={`category-toggle-${row.id}`} aria-label={`Show ${row.label.toLowerCase()}`} />
          <span className="name">
            <CategoryIcon category={row.id} color={row.color} size={18} />
            {row.label}
          </span>
        </label>
        <Count data-category-count="" title={`${formatCount(row.count)} seen in the last ${hours}`}>
          {formatCount(row.count)}
        </Count>
        <Expand
          type="button"
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} the species under ${row.label.toLowerCase()}`}
          disabled={!canOpen}
          style={canOpen ? undefined : { visibility: "hidden" }}
          data-testid={`category-expand-${row.id}`}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "▴" : "▾"}
        </Expand>
      </Row>
      {open && canOpen ? (
        <li>
          <Species aria-label={`Species under ${row.label}`}>
            {row.species.map((s) => (
              <Row key={s.id} data-category-species={s.id} data-off={s.on ? undefined : ""}>
                <label>
                  <input type="checkbox" checked={s.on} onChange={(e) => setTaxonVisible(s.id, e.currentTarget.checked === row.on ? null : e.currentTarget.checked)} data-testid={`species-toggle-${s.id}`} aria-label={`Show ${s.name}`} />
                  <span className="name">{s.name}</span>
                </label>
                <Count data-species-count="">{formatCount(s.count)}</Count>
                <span />
              </Row>
            ))}
          </Species>
        </li>
      ) : null}
    </>
  );
}

/**
 * The "Other" chip's popover (T44): every category with its icon, colour, count and switch, and each one
 * expandable to its most-seen species with their own switches. A species switch that matches its category
 * drops the override, so the species follows the category again.
 */
export default function CategoriesPopover({ id, rows, hours, popRef, onClose }: { id: string; rows: CategoryRow[]; hours: string; popRef: RefObject<HTMLDivElement | null>; onClose: () => void }) {
  return (
    <PopoverBox id={id} label="Species categories" testId="categories-popover" popRef={popRef} onClose={onClose} align="left">
      <Head>
        <span>Which kinds of sightings to show, with how many were seen in the last {hours}.</span>
        <button type="button" onClick={showAllSpecies} data-testid="categories-all-animals" title="Every animal on; insects, spiders and plants keep their switches">
          All animals
        </button>
      </Head>
      <List>
        {rows.map((row) => (
          <CategoryItem key={row.id} row={row} hours={hours} />
        ))}
      </List>
    </PopoverBox>
  );
}

export type { CategoryId };
