import org.gradle.api.tasks.Sync

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The web layer, the injected content scripts and the ad-block list all live
// outside this directory — they are shared with the Chrome extension and the
// iOS app, and forking them into the Android tree is exactly the drift this
// project is built to avoid. So they are copied in at build time instead.
val repoRoot = rootProject.projectDir.parentFile
val generatedAssets = layout.buildDirectory.dir("generated/assets/panelflow")

// `Sync` rather than `Copy`: a file deleted upstream must disappear from the
// APK too, or a stale script keeps being injected long after it stopped existing.
val bundleWebAssets by tasks.registering(Sync::class) {
    description = "Assembles the shared web layer into the APK's assets."
    into(generatedAssets)

    // The app shell and the offscreen worker, served from a real https origin
    // (see AssetHost.kt) so localStorage is durable rather than opaque.
    from("$repoRoot/mobile/www") { into("www") }

    // Everything injected into pages the user browses. Ordering is enforced in
    // PageScripts.kt, not here.
    from("$repoRoot/mobile/inject") { into("inject") }
    from("$repoRoot/shared/series-match.js") { into("inject") }
    from("$repoRoot/extension/content") {
        into("inject")
        include("popup-guard.js", "detect.js", "library-modal.js", "reader.js", "reader.css")
    }

    from("$repoRoot/extension/rules/adblock.json") { into("rules") }
    from("$repoRoot/shared/detection-rules.json") { into("rules") }
}

android {
    namespace = "dev.panelflow"
    compileSdk = 34

    defaultConfig {
        applicationId = "dev.panelflow"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"

        // Where the app talks to. Overridable per build; the user can also point
        // the app at their own server from the account tab at runtime.
        buildConfigField(
            "String",
            "BACKEND_URL",
            "\"${project.findProperty("panelflow.backendUrl") ?: "https://panelflow.vercel.app"}\"",
        )
    }

    buildFeatures {
        buildConfig = true
        viewBinding = false
    }

    sourceSets["main"].assets.srcDir(generatedAssets)

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

tasks.named("preBuild") { dependsOn(bundleWebAssets) }

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.2")
    // WebViewAssetLoader: serves the bundled shell over https instead of file://.
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("com.google.android.material:material:1.12.0")
}
