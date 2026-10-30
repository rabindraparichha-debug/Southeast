import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useRef } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button } from './ui';
import { colors, space } from './theme';
import { t } from '@/i18n';

/** Full-screen QR scanner for tiffin stickers. Calls onScanned once with the raw QR text. */
export function QrScanner({ visible, onScanned, onClose }: { visible: boolean; onScanned: (data: string) => void; onClose: () => void }) {
  const [perm, requestPerm] = useCameraPermissions();
  const done = useRef(false);

  const handle = (r: BarcodeScanningResult) => {
    if (done.current || !r.data) return;
    done.current = true;
    onScanned(r.data);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} onShow={() => { done.current = false; }}>
      <View style={styles.screen}>
        {perm?.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={handle}
          />
        ) : (
          <View style={styles.center}>
            <Text style={styles.text}>{perm && !perm.canAskAgain ? t('rider.scan.cameraBlocked') : t('rider.scan.cameraNeeded')}</Text>
            {(!perm || perm.canAskAgain) && <Button title={t('rider.scan.allowCamera')} onPress={() => void requestPerm()} />}
          </View>
        )}
        <View style={styles.frame} pointerEvents="none" />
        <View style={styles.bottom}>
          <Text style={styles.hint}>{t('rider.scan.hint')}</Text>
          <Pressable onPress={onClose} style={styles.close} accessibilityRole="button">
            <Text style={styles.closeText}>{t('rider.scan.cancel')}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space(6), gap: space(4) },
  text: { color: '#fff', fontSize: 16, textAlign: 'center' },
  frame: {
    position: 'absolute', top: '25%', left: '15%', right: '15%', aspectRatio: 1,
    borderWidth: 3, borderColor: colors.brand, borderRadius: 16,
  },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: space(6), gap: space(3), backgroundColor: 'rgba(0,0,0,0.55)' },
  hint: { color: '#fff', fontSize: 15, textAlign: 'center' },
  close: { alignSelf: 'center', paddingVertical: space(3), paddingHorizontal: space(8), borderRadius: 999, backgroundColor: '#fff' },
  closeText: { color: colors.ink, fontSize: 16, fontWeight: '600' },
});
