# dsh-web-mcp

**dsh-web-mcp** adalah plugin untuk DeepSeek Harness (DSH). Plugin ini membuat tools yang tersedia di DSH dapat diakses oleh aplikasi lain melalui protokol MCP (Model Context Protocol) menggunakan HTTP lokal yang dilindungi token.

> **Status versi:** package ditandai `0.2.1-rc.2`, sesuai target port. Namun, kompatibilitas dengan DSH `0.2.1-rc.2` belum diverifikasi secara langsung. Dokumentasi sumber menyebut baseline pengujian DSH `0.1.0-rc.6`.

## Apa yang bisa dilakukan?

- Menyediakan tools DSH melalui endpoint MCP Streamable HTTP.
- Menggunakan pipeline eksekusi tools DSH beserta pemeriksaan yang dimiliki harness.
- Melindungi endpoint dengan bearer token dan pemeriksaan host/origin.
- Mengatur batas ukuran request dan waktu tunggu pemanggilan tool.
- Menyertakan integrasi opsional untuk mendelegasikan tugas ke percakapan DeepSeek web.

## Persiapan

Sebelum mulai, pastikan Anda memiliki:

1. Node.js versi 20 atau lebih baru.
2. Git.
3. DeepSeek Harness (DSH) yang sudah terpasang.
4. Klien MCP yang mendukung Streamable HTTP jika ingin menghubungkan aplikasi lain.

Periksa instalasi Node.js dengan `node --version` dan DSH dengan `dsh --help`.

## Instalasi langkah demi langkah

### 1. Unduh kode

Buka terminal, lalu jalankan:

```sh
git clone https://github.com/mulqizamzam/dsh-web-mcp.git
cd dsh-web-mcp
```

### 2. Buat token rahasia

Token diperlukan agar hanya klien yang mengetahui token yang dapat mengakses endpoint MCP. Buat token acak dengan perintah:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Salin hasilnya dan simpan secara aman. Jangan membagikan token atau menyimpannya di repository publik.

### 3. Masukkan token ke konfigurasi

Buka file `dsh-mcp-server/cordis.patch.yml` menggunakan editor teks. Temukan nilai placeholder `CHANGE_ME`, lalu ganti dengan token yang Anda buat. Struktur konfigurasi umumnya seperti berikut:

```yaml
- insert:
    - id: mcp-server
      name: dsh-mcp-server
      config:
        token: "GANTI_DENGAN_TOKEN_RAHASIA_ANDA"
        allowedOrigins: []
```

Ganti teks contoh tersebut dengan token asli Anda. Jangan commit file yang berisi token asli ke Git.

Untuk pemakaian melalui browser, tambahkan origin ekstensi browser yang tepat ke `allowedOrigins` jika diperlukan. Jangan menambahkan origin yang tidak Anda kenal.

### 4. Pasang plugin

Pastikan terminal berada di direktori utama repository `dsh-web-mcp`, lalu jalankan:

```sh
dsh plugin --profile web add ./dsh-mcp-server
```

Perintah ini memasang plugin ke profil DSH bernama `web`. Jika profil Anda berbeda, sesuaikan nama profil berdasarkan konfigurasi DSH Anda.

### 5. Jalankan DSH

```sh
dsh web
```

Endpoint default plugin adalah:

`http://127.0.0.1:3080/mcp`

Alamat ini ditujukan untuk akses lokal pada komputer yang sama.

### 6. Hubungkan klien MCP

Di pengaturan MCP aplikasi klien, tambahkan server baru dengan nilai berikut:

| Pengaturan | Nilai |
| --- | --- |
| Transport | `streamable_http` |
| URL | `http://127.0.0.1:3080/mcp` |
| Autentikasi | Bearer token |
| Token | Token rahasia yang dibuat pada langkah 2 |

Nama menu dapat berbeda di setiap aplikasi. Jika aplikasi meminta bearer token, masukkan token yang sama dengan konfigurasi plugin.

## Pengaturan yang tersedia

Opsi berikut didokumentasikan oleh implementasi sumber. Opsi harus berada di bagian `config` pada komponen `mcp-server`.

| Opsi | Default | Fungsi |
| --- | --- | --- |
| `path` | `/mcp` | Jalur endpoint HTTP. |
| `token` | Wajib | Token autentikasi untuk request. |
| `agentPreset` | Tidak diatur | Memilih sesi terbaru dari preset agent tertentu. |
| `sessionId` | Tidak diatur | Memilih satu sesi dengan ID tertentu. |
| `allowedOrigins` | `[]` | Origin browser yang diizinkan. |
| `trustedHosts` | `[]` | Host non-loopback tambahan yang dipercaya. |
| `maxRequestBytes` | `1048576` | Ukuran maksimum body request (1 MiB). |
| `toolTimeoutMs` | `300000` | Batas waktu satu pemanggilan tool (5 menit). |

Jika beberapa sesi DSH terbuka bersamaan, atur `agentPreset` atau `sessionId` agar klien menggunakan sesi yang dimaksud.

## Integrasi opsional: DeepSeek web subagent

Folder `integrations/dsh-subagent-deepseek-web/` berisi plugin tambahan untuk mendelegasikan tugas dari agent DSH ke percakapan DeepSeek web. Ini **bukan bagian yang wajib** untuk menggunakan MCP server inti.

Pasang integrasi setelah core plugin siap:

```sh
dsh plugin --profile web add ./integrations/dsh-subagent-deepseek-web
```

Tool provider juga harus ditambahkan ke preset agent yang dipakai:

```yaml
- id: tool-subagent-deepseek-web
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: deepseek-web
    toolName: subagent_deepseek_web
    enableRunInBackground: false
    maxDepth: provider-managed
```

Fitur ini memerlukan browser delegate DeepSeek yang kompatibel, sesi DeepSeek web, serta MCP bridge yang berjalan. Untuk petunjuk lebih lanjut, baca [README integrasi](integrations/dsh-subagent-deepseek-web/README.md).

## Menjalankan pemeriksaan

Skrip verifikasi memerlukan instalasi DSH dan modul Cordis yang sesuai. Ganti path contoh di bawah dengan lokasi sebenarnya pada komputer Anda:

```sh
DSH_CORDIS_ENTRY=/path/ke/cordis/lib/index.js node dsh-mcp-server/verify-protocol.mjs
```

Untuk memeriksa provider opsional:

```sh
DSH_CORDIS_ENTRY=/path/ke/cordis/lib/index.js node integrations/dsh-subagent-deepseek-web/verify-provider.mjs
```

Skrip live memerlukan server DSH yang berjalan, plugin terkait yang terpasang, dan sesi browser yang sesuai. Keberadaan skrip bukan bukti bahwa tes sudah dijalankan atau lulus. Jalankan pengujian pada DSH `0.2.1-rc.2` sebelum menganggap kompatibilitas terverifikasi.

## Pemecahan masalah

| Masalah | Solusi awal |
| --- | --- |
| `401 Unauthorized` | Pastikan token di konfigurasi sama dengan token yang dikirim klien sebagai bearer token. |
| Origin ditolak | Periksa origin browser yang tepat pada `allowedOrigins`. |
| Host ditolak | Gunakan alamat loopback atau tinjau konfigurasi `trustedHosts`. |
| Tools tidak muncul | Pastikan sesi DSH aktif dan `agentPreset`/`sessionId` mengarah ke sesi yang benar. |
| Pemanggilan tool timeout | Periksa proses tool; naikkan `toolTimeoutMs` hanya jika diperlukan. |
| Tool subagent tidak tersedia | Pastikan integrasi opsional dipasang dan tool provider ada di preset agent. |
| Plugin gagal dimuat | Periksa versi DSH, output terminal, dan file `cordis.patch.yml`. |
| Perintah `dsh` tidak ditemukan | Pastikan DSH sudah dipasang dan tersedia di PATH. |

## Keamanan

Bearer token memberi akses ke tools pada sesi DSH yang dipilih. Tools tersebut dapat mencakup akses file dan perintah shell.

- Buat token acak dan unik.
- Jangan commit token ke GitHub.
- Batasi origin dan host yang dipercaya.
- Jangan membuka endpoint ke internet atau jaringan publik tanpa perlindungan yang sesuai.
- Periksa tools yang tersedia sebelum memberi akses kepada klien lain.

## Lisensi

File plugin inti mempertahankan lisensi MIT dari sumber. Untuk integrasi browser/subagent, baca file lisensi pada direktori integrasi dan perhatikan ketentuan atribusi proyek upstream.
