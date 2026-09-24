import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GithubCredential } from '../api/types.ts';

/**
 * The admin credential panel is the only surface that consumes the server's
 * GitHub credential API, so these cases pin what it may reveal and who may see
 * it. Two claims matter: a non-admin is told to ask an administrator rather
 * than shown a form, and an admin sees a fingerprint and a source but never a
 * credential value — the browser must have no way to read one back.
 */
const githubCredential = vi.fn();
vi.mock('../api/client.ts', () => ({
  api: {
    githubCredential: () => githubCredential(),
    testGithubCredential: vi.fn(),
    setGithubCredential: vi.fn(),
    clearGithubCredential: vi.fn(),
  },
}));

const { GithubCredentialCard } = await import('../components/GithubCredential.tsx');

const stored: GithubCredential = {
  configured: true,
  source: 'database',
  tokenKind: 'fine-grained-pat',
  fingerprint: '0d6ba110a99a3b3a',
  repo: 'rasonjonathan6-coder/app',
  updatedAt: new Date().toISOString(),
  editable: true,
  databaseConfigured: true,
  envVariable: 'MY_AI_STUDIO_GITHUB_TOKEN',
  detail: 'repository reachable; rasonjonathan6-coder/app default branch main',
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GitHub credential panel', () => {
  it('tells a non-admin that administrator privileges are required, and asks the server nothing', () => {
    render(<GithubCredentialCard isAdmin={false} />);
    expect(screen.getByText(/administrator privileges are required/i)).toBeTruthy();
    expect(githubCredential).not.toHaveBeenCalled();
  });

  it('shows an admin the credential source and fingerprint without any credential value', async () => {
    githubCredential.mockResolvedValue(stored);
    render(<GithubCredentialCard isAdmin />);

    await waitFor(() => expect(screen.getByText('0d6ba110a99a3b3a')).toBeTruthy());
    expect(screen.getByText('database')).toBeTruthy();
    expect(screen.getByText('fine-grained-pat')).toBeTruthy();
    expect(screen.getByText('rasonjonathan6-coder/app')).toBeTruthy();

    // The credential entry field must start empty: the server never returns the
    // value, so the panel has nothing to prefill even for an admin.
    const input = document.querySelector('#gh-token') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe('');
    expect(input.type).toBe('password');
  });

  it('offers removal only when the credential actually lives in the database', async () => {
    githubCredential.mockResolvedValue(stored);
    render(<GithubCredentialCard isAdmin />);
    await waitFor(() => expect(screen.getByText('Remove stored')).toBeTruthy());
    expect((screen.getByText('Remove stored') as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not offer removal of an environment credential it cannot delete', async () => {
    githubCredential.mockResolvedValue({ ...stored, source: 'env', updatedAt: null });
    render(<GithubCredentialCard isAdmin />);
    await waitFor(() => expect(screen.getByText('Remove stored')).toBeTruthy());
    expect((screen.getByText('Remove stored') as HTMLButtonElement).disabled).toBe(true);
  });

  it('surfaces a server error instead of pretending the credential is configured', async () => {
    githubCredential.mockRejectedValue(new Error('administrator privileges required'));
    render(<GithubCredentialCard isAdmin />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/administrator privileges required/);
  });
});
