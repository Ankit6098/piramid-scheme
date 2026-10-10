'use client';

import { toDataURL } from 'qrcode';
import { useEffect, useState } from 'react';

import { Skeleton } from '@/components/ui/skeleton';

/**
 * Renders an `otpauth://` URI as a QR code image, generated in the browser (the secret never goes to
 * a third-party QR service). Dark modules on a white quiet zone so it scans in both themes.
 */
export function TotpQrCode({ uri, accountName }: { uri: string; accountName: string }) {
  const [dataUrl, setDataUrl] = useState<{ uri: string; src: string } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    toDataURL(uri, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 208,
      color: { dark: '#0f172a', light: '#ffffff' },
    })
      .then((src) => {
        if (!cancelled) setDataUrl({ uri, src });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [uri]);

  if (failed) {
    return (
      <p className="text-sm text-muted-foreground">
        The QR code could not be drawn. Enter the setup key below instead.
      </p>
    );
  }
  if (!dataUrl || dataUrl.uri !== uri)
    return <Skeleton className="size-52 rounded-lg" aria-label="Generating QR code" />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- data: URL generated locally; next/image adds nothing here
    <img
      src={dataUrl.src}
      width={208}
      height={208}
      alt={`QR code to add ${accountName} to an authenticator app`}
      className="size-52 rounded-lg bg-white ring-1 ring-foreground/10"
    />
  );
}
