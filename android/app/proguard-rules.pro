# The bridge is reached from JavaScript by name. R8 has no way to see those
# call sites, so without this the release build strips the one method the whole
# app talks through and every screen comes up empty.
-keepclassmembers class dev.panelflow.NativeBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class dev.panelflow.NativeBridge { *; }
