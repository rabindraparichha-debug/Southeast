import { StyleSheet, View } from 'react-native';
import { LANGUAGES, chooseLanguage, t, useLanguage } from '@/i18n';
import { Card, Chip, Label, Muted } from './ui';
import { space } from './theme';

/**
 * Language for this phone (saved on the phone, D-130). Odia and Hindi are drafts until a native
 * speaker has checked them (D-006); anything not translated yet shows in English.
 */
export function LanguagePicker() {
  const lang = useLanguage();
  return (
    <Card>
      <Label>{t('account.language')}</Label>
      <View style={styles.chips}>
        {LANGUAGES.map((l) => (
          <Chip key={l.code} label={l.label} selected={l.code === lang} onPress={() => void chooseLanguage(l.code)} />
        ))}
      </View>
      {lang !== 'en' && <Muted>{t('account.languageDraft')}</Muted>}
    </Card>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
});
