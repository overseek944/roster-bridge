# 4. Source credentials are stored in plaintext, and that is a known defect

**Status:** accepted for the demonstration, not for production

## Context

Each configured source needs OAuth client credentials for the district's
OneRoster endpoint. They are currently written to the `sources` table as text.

## Decision

Ship it this way for the demonstration, and record the defect here rather than
leave it for a reviewer to find.

## Why it is acceptable *here*

Every credential in this deployment belongs to the sandbox, which serves
synthetic data and holds nothing about a real person.

## Why it is not acceptable in production

A district's OneRoster credentials are keys to that district's student data.
Plaintext at rest means a database read is a full compromise, and it is exactly
what a district security review asks about.

## The fix

Encrypt at rest with a key held in Workers Secrets or a KMS, decrypting only in
the request that needs it, so a database dump is not sufficient to use the
credential. The `sources` table already isolates them behind one accessor, so
this is a contained change rather than a refactor.
