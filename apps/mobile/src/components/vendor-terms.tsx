import { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { WEB_URL } from '@/lib/env';
import { acceptVendorTerms } from '@/lib/legal';
import { supabase } from '@/lib/supabase';
import { friendlyError } from '@/lib/errors';
import { Button, Card, ErrorText, Muted } from '@/components/ui';
import { colors, space } from '@/components/theme';
import { t } from '@/i18n';

/** The "I accept" row with links to the vendor terms and the DPA on the web (D-181). */
export function TermsCheckbox({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={styles.row}>
      <Pressable onPress={() => onChange(!checked)} accessibilityRole="checkbox" accessibilityState={{ checked }} hitSlop={8}>
        <Text style={styles.box}>{checked ? '☑' : '☐'}</Text>
      </Pressable>
      <Text style={styles.text}>
        {t('terms.accept')}{' '}
        {WEB_URL ? (
          <>
            <Text style={styles.link} onPress={() => void Linking.openURL(`${WEB_URL}/legal/vendor-terms`)}>{t('terms.vendorTerms')}</Text>
            {' · '}
            <Text style={styles.link} onPress={() => void Linking.openURL(`${WEB_URL}/legal/dpa`)}>{t('terms.dpa')}</Text>
          </>
        ) : null}
      </Text>
    </View>
  );
}

/** Home card for an owner whose kitchen has not accepted the current versions yet. */
export function VendorTermsCard({ kitchenId, version }: { kitchenId: string; version: number }) {
  const [needed, setNeeded] = useState(false);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    supabase.rpc('vendor_terms_status', { p_kitchen: kitchenId }).then(({ data }) => {
      if (alive) setNeeded((data as { accepted?: boolean } | null)?.accepted === false);
    });
    return () => {
      alive = false;
    };
  }, [kitchenId, version]);

  if (!needed) return null;
  async function accept() {
    setBusy(true);
    setError('');
    const { error } = await acceptVendorTerms(kitchenId);
    setBusy(false);
    if (error) return setError(friendlyError(error));
    setNeeded(false);
  }
  return (
    <Card>
      <Text style={styles.title}>{t('terms.title')}</Text>
      <Muted>{t('terms.help')}</Muted>
      <TermsCheckbox checked={checked} onChange={setChecked} />
      <ErrorText>{error}</ErrorText>
      <Button title={t('terms.button')} onPress={accept} busy={busy} disabled={!checked} />
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space(2), marginVertical: space(2) },
  box: { fontSize: 22, color: colors.brand },
  text: { flex: 1, color: colors.inkSoft },
  link: { color: colors.brand, textDecorationLine: 'underline' },
  title: { fontSize: 16, fontWeight: '600', color: colors.ink },
});
