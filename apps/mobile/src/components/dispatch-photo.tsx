import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SLOT_LABEL, formatIstShort, istDate } from '@tiffin/core';
import type { MealSlot } from '@tiffin/db';
import { friendlyError } from '@/lib/errors';
import { isNetworkError, uuid } from '@/lib/rider-store';
import { readPhotoBytes } from '@/lib/stock';
import { supabase } from '@/lib/supabase';
import { t } from '@/i18n';
import { Button, Card, Chip, ErrorText, Muted } from './ui';
import { colors, radius, space } from './theme';

type Photo = { slot: MealSlot; taken_at: string; photo_path: string };

/** Lunch until 4 pm IST, dinner after. */
function currentSlot(): MealSlot {
  const istHour = new Date(Date.now() + 330 * 60000).getUTCHours();
  return istHour < 16 ? 'lunch' : 'dinner';
}

/**
 * Packed-meals photo for today's slot (owner + staff). The photo goes to the private 'dispatch'
 * bucket under <kitchen_id>/<date>/..., then record_dispatch_photo stores it; a retake replaces
 * the photo but keeps the first time (the "prepared" time for late-delivery alerts).
 */
export function DispatchPhotoCard({ kitchenId, version }: { kitchenId: string; version: number }) {
  const today = istDate();
  const [slot, setSlot] = useState<MealSlot>(currentSlot);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [thumb, setThumb] = useState<{ path: string; url: string } | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    supabase.from('dispatch_photos').select('slot, taken_at, photo_path')
      .eq('kitchen_id', kitchenId).eq('service_date', today).is('run_id', null)
      .then(({ data }) => {
        if (alive) setPhotos((data ?? []) as Photo[]);
      });
    return () => {
      alive = false;
    };
  }, [kitchenId, today, version, reload]);

  const photo = photos.find((p) => p.slot === slot);
  const path = photo?.photo_path;

  // Small preview of the saved photo (signed URL: the bucket is private).
  useEffect(() => {
    if (!path) return;
    let alive = true;
    supabase.storage.from('dispatch').createSignedUrl(path, 600).then(({ data }) => {
      if (alive && data?.signedUrl) setThumb({ path, url: data.signedUrl });
    });
    return () => {
      alive = false;
    };
  }, [path]);

  const take = async () => {
    setError('');
    setStatus('');
    let uri: string;
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) return setError(t('dispatch.cameraDenied'));
      const shot = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.4, allowsEditing: false, exif: false });
      if (shot.canceled || !shot.assets[0]) return;
      uri = shot.assets[0].uri;
    } catch {
      return setError(t('dispatch.cameraFailed'));
    }
    const takenAt = new Date().toISOString();
    const path = `${kitchenId}/${today}/${slot}-${uuid()}.jpg`;
    setBusy(true);
    setStatus(t('dispatch.uploading'));
    try {
      const bytes = await readPhotoBytes(uri);
      const { error: up } = await supabase.storage.from('dispatch').upload(path, bytes, { contentType: 'image/jpeg' });
      if (up) {
        setBusy(false);
        setStatus('');
        return setError(isNetworkError(up as { message: string }) ? t('dispatch.offline') : `${t('errors.invalid_photo')} (${up.message})`);
      }
    } catch {
      setBusy(false);
      setStatus('');
      return setError(t('dispatch.offline'));
    }
    const { error: e } = await supabase.rpc('record_dispatch_photo', {
      p_kitchen: kitchenId, p_date: today, p_slot: slot, p_photo_path: path, p_at: takenAt,
    });
    setBusy(false);
    if (e) {
      setStatus('');
      return setError(isNetworkError(e) ? t('dispatch.offline') : friendlyError(e));
    }
    setStatus(t('dispatch.saved'));
    setReload((n) => n + 1);
  };

  return (
    <Card>
      <Text style={styles.title}>📸 {t('dispatch.title')}</Text>
      <View style={styles.chips}>
        {(['lunch', 'dinner'] as const).map((s) => (
          <Chip key={s} label={`${SLOT_LABEL[s]}${photos.some((p) => p.slot === s) ? ' ✓' : ''}`} selected={slot === s} onPress={() => setSlot(s)} />
        ))}
      </View>
      {photo ? (
        <View style={styles.row}>
          {thumb && thumb.path === photo.photo_path ? <Image source={{ uri: thumb.url }} style={styles.thumb} contentFit="cover" /> : <View style={[styles.thumb, styles.thumbEmpty]} />}
          <Text style={styles.ok}>✓ {t('dispatch.takenAt', { time: formatIstShort(photo.taken_at) })}</Text>
        </View>
      ) : (
        <Muted>{t('dispatch.none', { slot: SLOT_LABEL[slot] })} {t('dispatch.hint')}</Muted>
      )}
      {status ? <Text style={styles.ok}>{status}</Text> : null}
      <ErrorText>{error}</ErrorText>
      <Button title={photo ? t('dispatch.retake') : t('dispatch.take')} variant={photo ? 'secondary' : 'primary'} onPress={take} busy={busy} />
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 16, fontWeight: '600', color: colors.ink },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  row: { flexDirection: 'row', alignItems: 'center', gap: space(3) },
  thumb: { width: 64, height: 64, borderRadius: radius / 2 },
  thumbEmpty: { backgroundColor: colors.line },
  ok: { color: colors.veg, fontWeight: '600', flexShrink: 1 },
});
