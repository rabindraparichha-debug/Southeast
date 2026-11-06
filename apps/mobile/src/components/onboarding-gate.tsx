import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, View } from 'react-native';
import type { OnboardingStatus } from '@tiffin/db';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/session';
import { Button, Card, Muted, Title } from '@/components/ui';
import { SupportLink } from '@/components/support-link';
import { colors, space } from '@/components/theme';
import { t } from '@/i18n';

type Gate = { kind: 'checking' } | { kind: 'failed' } | { kind: 'joining' } | { kind: 'not_approved'; applied: boolean } | { kind: 'open' };

/** Claims waiting invites, then asks the server what this login may do. */
async function fetchGate(): Promise<{ gate: Gate; joined: boolean }> {
  const claim = await supabase.rpc('claim_invites');
  const { data, error } = await supabase.rpc('onboarding_status');
  if (claim.error || error || !data) return { gate: { kind: 'failed' }, joined: false };
  const status = data as unknown as OnboardingStatus;
  if (status.memberships > 0) return { gate: { kind: 'joining' }, joined: true };
  if (status.pending_invites > 0) return { gate: { kind: 'joining' }, joined: false };
  if (!status.can_create_kitchen) {
    return { gate: { kind: 'not_approved', applied: Boolean(status.application && status.application.status !== 'rejected') }, joined: false };
  }
  return { gate: { kind: 'open' }, joined: false };
}

/**
 * Wave 4 (D-126): "Set up your kitchen" shows the create form only to approved numbers. An invited
 * staff member or rider is joined to their kitchen and sent there; when the check fails or an invite
 * is still waiting (slow network) they get a retry, never the form.
 */
export function OnboardingGate({ children }: { children: ReactNode }) {
  const { reload } = useAuth();
  const [gate, setGate] = useState<Gate>({ kind: 'checking' });
  // reload changes identity whenever the memberships change; the check must not re-run because of it.
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);

  const apply = useCallback(async (r: { gate: Gate; joined: boolean }) => {
    setGate(r.gate);
    // The root layout switches to the kitchen once the memberships are loaded again.
    if (r.joined) await reloadRef.current();
  }, []);

  const check = useCallback(async () => {
    setGate({ kind: 'checking' });
    await apply(await fetchGate());
  }, [apply]);

  useEffect(() => {
    let alive = true;
    void fetchGate().then((r) => {
      if (alive) void apply(r);
    });
    return () => {
      alive = false;
    };
  }, [apply]);

  if (gate.kind === 'open') return <>{children}</>;
  if (gate.kind === 'checking') {
    return (
      <View style={{ padding: space(6) }}>
        <ActivityIndicator color={colors.brand} />
      </View>
    );
  }
  if (gate.kind === 'not_approved') {
    return (
      <Card>
        <Title>{t('onboarding.notApproved')}</Title>
        <Muted>{gate.applied ? t('onboarding.notApprovedApplied') : t('onboarding.notApprovedApply')}</Muted>
        <Muted>{t('onboarding.staffHint')}</Muted>
        <Button title={t('onboarding.retry')} onPress={() => void check()} variant="secondary" />
        <SupportLink text={t('support.approveMessage')} />
      </Card>
    );
  }
  return (
    <Card>
      <Title>{gate.kind === 'failed' ? t('onboarding.checkFailed') : t('onboarding.joining')}</Title>
      <Muted>{gate.kind === 'failed' ? t('onboarding.checkFailedHelp') : t('onboarding.joiningHelp')}</Muted>
      <Button title={t('onboarding.retry')} onPress={() => void check()} />
      <SupportLink />
    </Card>
  );
}
