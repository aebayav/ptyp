package app.turguz.ptyp;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import androidx.annotation.NonNull;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

/**
 * Saha GPS özellikleri (en yakın direk, mesafe doğrulaması, yanlış-direk uyarısı)
 * WebView'daki navigator.geolocation üzerinden çalışır; Android 6+ için çalışma
 * zamanı konum izni uygulama tarafından istenmelidir — burada açılışta istenir.
 */
public class MainActivity extends BridgeActivity {

  private static final int REQ_LOCATION = 701;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    requestLocationPermissionIfNeeded();
  }

  private void requestLocationPermissionIfNeeded() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
    if (hasLocationPermission()) return;
    ActivityCompat.requestPermissions(
        this,
        new String[] { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION },
        REQ_LOCATION
    );
  }

  private boolean hasLocationPermission() {
    return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
            == PackageManager.PERMISSION_GRANTED
        || ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION)
            == PackageManager.PERMISSION_GRANTED;
  }

  @Override
  public void onRequestPermissionsResult(
      int requestCode,
      @NonNull String[] permissions,
      @NonNull int[] grantResults
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    if (requestCode != REQ_LOCATION) return;
    if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
      // Konum izni verildi — WebView geolocation istekleri artık yanıtlanabilir
    }
    // Reddedilirse uygulama çalışmaya devam eder; saha GPS özellikleri kapatılır
  }
}
