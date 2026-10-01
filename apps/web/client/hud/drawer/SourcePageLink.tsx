"use client";

import ExternalLink from "client/external-link";
import styled from "client/styled";
import { publisherOf } from "shared/source-pages";

import { Icon, Mono } from "../primitives";

const Link = styled(ExternalLink)`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid color-mix(in oklab, var(--accent) 55%, var(--border));
  border-radius: var(--radius-s);
  color: var(--accent);
  font: 600 12px / 1 var(--font-ui);
  white-space: nowrap;
  text-decoration: none;
  &:hover,
  &:focus-visible {
    background: color-mix(in oklab, var(--accent) 14%, transparent);
  }
`;

/**
 * "Open at <publisher> ↗" for the record's page at its publisher (PLAN.md C19). Renders nothing unless the URL
 * is https on an allowlisted publisher host.
 */
export default function SourcePageLink({ url }: { url: string | null | undefined }) {
  const publisher = publisherOf(url);
  if (!publisher || !url) return null;
  return (
    <Link href={url} title={`Open this record at ${publisher} in a new tab`} data-testid="source-page-link">
      Open at {publisher} <Icon name="external" />
    </Link>
  );
}

/**
 * One record field's value: a new-tab link when it is an https URL on an allowlisted publisher host, text
 * otherwise (API URLs, photo hosts and anything else stay plain).
 */
export function RecordValue({ value, text }: { value: unknown; text: string }) {
  const publisher = publisherOf(value);
  if (publisher && typeof value === "string") {
    return (
      <ExternalLink href={value} title={`Open at ${publisher} in a new tab`}>
        <Mono>{text}</Mono> <Icon name="external" />
      </ExternalLink>
    );
  }
  return <Mono>{text}</Mono>;
}
