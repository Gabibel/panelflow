# Registre des sites

Généré par `node scripts/check-sites.mjs`. Dernière vérification : **2026-09-18**. Ne pas éditer à la main : relancer le script.

Chaque domaine de `shared/detection-rules.json` est visité une fois (page d'accueil), et pour les sites de lecture qui répondent, le premier lien de chapitre trouvé est passé à `shared/compat.js`, l'analyse que le lecteur lui-même exécute. Une ligne est une preuve datée, pas une promesse.

**Lire les colonnes.** `ok` : la page d'accueil répond. `challenge` : un mur anti-robot (Cloudflare) répond à la place de la page ; depuis un téléphone le site marche souvent, depuis ce PC non. `moved` : le domaine redirige vers un autre, l'entrée est périmée. `error:ENOTFOUND` : le domaine n'existe plus. `http:4xx/5xx` : le serveur refuse. Le verdict est celui du lecteur sur la page échantillon : `ready`/`likely` veut dire qu'il s'ouvrirait ; `no-sample` que ni la page d'accueil, ni la première page de série qu'elle lie, ni `docs/sites-samples.json` ne donnent de chapitre à regarder. `hand:…` est un verdict écrit par une personne qui a ouvert le site dans un navigateur (`dead` : domaine parqué ou expiré ; `moved` : le site a changé de domaine ; `blocked` : ce réseau ne le laisse pas charger ; `account` : il faut un compte ; `app` : la lecture se fait dans une application). Un échantillon marqué (main) vient du même fichier.

Accueil : error:timeout 68 · ok 64 · http:403 42 · challenge 26 · moved 17 · error:ENOTFOUND 6 · error:certificate 4 · http:500 2 · http:404 2 · http:526 1 · http:502 1 · error:ECONNREFUSED 1.
Verdicts : likely 14 · ready 11 · hand:blocked 5 · sample-http:403 4 · sample-challenge 2 · no-sample 2 · sample-error:timeout 1.

| Domaine | Type | Accueil | Verdict | Images | Échantillon | Note |
|---|---|---|---|---|---|---|
| 1stkissmanga.me | reading | error:certificate |  |  |  |  |
| 3asq.org | reading | moved → 3asq.online |  |  |  |  |
| 69shuba.com | reading | http:403 |  |  |  |  |
| 9animetv.to | video | error:timeout |  |  |  |  |
| agit.top | reading | error:timeout |  |  |  |  |
| allanime.to | video | error:timeout |  |  |  |  |
| allnovel.net | reading | error:timeout |  |  |  |  |
| alphapolis.co.jp | reading | ok | likely | 0 | [lien](https://www.alphapolis.co.jp/novel/500033287/535917677/episode/8971219) (main) | vu : text chapter: 419 paragraphs, 55 435 characters ; episode path /novel/<author>/<work>/episode/<id> |
| anicloud.to | video | error:certificate |  |  |  |  |
| anilab.to | video | error:timeout |  |  |  |  |
| anime-sama.fr | video | error:timeout |  |  |  |  |
| anime-sama.org | video | error:timeout |  |  |  |  |
| animeblix.com | video | error:ENOTFOUND |  |  |  |  |
| animedao.to | video | ok |  |  |  |  |
| animedigitalnetwork.fr | video | moved → animationdigitalnetwork.com |  |  |  |  |
| animeflv.net | video | error:timeout |  |  |  |  |
| animeheaven.me | video | ok |  |  |  |  |
| animekai.to | video | error:timeout |  |  |  |  |
| animension.to | video | ok |  |  |  |  |
| animeowl.me | video | ok |  |  |  |  |
| animepahe.ru | video | moved → animepahe.su |  |  |  |  |
| animesama.fr | video | error:timeout |  |  |  |  |
| animesaturn.cx | video | challenge |  |  |  |  |
| animesgratis.org | video | ok |  |  |  |  |
| animesonlinecc.net | video | error:timeout |  |  |  |  |
| animesuge.to | video | error:timeout |  |  |  |  |
| animeunity.so | video | challenge |  |  |  |  |
| animexin.dev | video | challenge |  |  |  |  |
| aniwatchtv.to | video | error:timeout |  |  |  |  |
| aniwave.to | video | ok |  |  |  |  |
| aniworld.to | video | ok |  |  |  |  |
| anix.to | video | error:certificate |  |  |  |  |
| asuracomic.net | reading | moved → asurascans.com |  |  |  |  |
| asurascans.com | reading | ok | ready | 35 | [lien](https://asurascans.com/comics/war-of-extinction-6f7fe6eb/chapter/7) |  |
| azorafly.com | reading | error:timeout |  |  |  |  |
| azuki.co | reading | error:timeout |  |  |  |  |
| bato.to | reading | error:timeout |  |  |  |  |
| betteranime.net | video | ok |  |  |  |  |
| bilibili.tv | video | ok |  |  |  |  |
| bilibilicomics.com | reading | error:timeout |  |  |  |  |
| centralnovel.com | reading | http:403 |  |  |  |  |
| chapmanganato.to | reading | error:timeout |  |  |  |  |
| chrysanthemumgarden.com | reading | challenge |  |  |  |  |
| coffeemanga.io | reading | error:timeout |  |  |  |  |
| comick.dev | reading | http:403 | sample-http:403 |  | [lien](https://comick.dev/comic/00-solo-max-level-newbie/EUlnpbT_-chapter-277-en) (main) | vu : 7 page images in the markup (meo.comick.pictures, 690 px, load fine when asked), lazy-loaded by the app after hydration ; comick.cc is parked (an ad redirect); comick.io redirects to comick.dev, which the rules do not list |
| comick.io | reading | http:403 |  |  |  |  |
| comikey.com | reading | challenge |  |  |  |  |
| crunchyscan.fr | reading | error:timeout |  |  |  |  |
| desu-online.pl | video | ok |  |  |  |  |
| doodstream.com | video | ok |  |  |  |  |
| fanmtl.com | reading | http:403 |  |  |  |  |
| filemoon.sx | video | ok |  |  |  |  |
| flamecomics.xyz | reading | challenge |  |  |  |  |
| fmteam.fr | reading | ok | ready | 20 | [lien](https://fmteam.fr/read/kingdom/fr/ch/888) (main) | vu : 21 page images in the markup (fmteam.fr/storage/comics/…, 1 133 px), slow to load ; chapter path /read/<slug>/<lang>/ch/<n>; series list at /mangas |
| foxaholic.com | reading | http:403 |  |  |  |  |
| franime.com | video | error:ENOTFOUND |  |  |  |  |
| franime.fr | video | challenge |  |  |  |  |
| freewebnovel.com | reading | http:403 |  |  |  |  |
| gogoanime.by | video | ok |  |  |  |  |
| gogoanimes.fi | video | error:timeout |  |  |  |  |
| goyabu.to | video | moved → goyabu.io |  |  |  |  |
| hianime.to | video | error:timeout |  |  |  |  |
| hivetoon.com | reading | challenge |  |  |  |  |
| hostednovel.com | reading | challenge |  |  |  |  |
| ikigaimangas.com | reading | challenge |  |  |  |  |
| immortalupdates.com | reading | http:403 |  |  |  |  |
| inkr.com | reading | ok | likely | 2 | [lien](https://comics.inkr.com/title/4910-blue-lock-episode-nagi?ref=section_new_noteworthy_home) |  |
| inmanga.com | reading | challenge |  |  |  |  |
| iq.com | video | ok |  |  |  |  |
| isotls.com | reading | ok | likely | 2 | [lien](https://www.isotls.com/novel/62cb747de619ae0a7ab21755/chapter/1735/update) |  |
| japscan.foo | reading | http:403 |  |  |  |  |
| japscan.lol | reading | challenge |  |  |  |  |
| jkanime.net | video | ok |  |  |  |  |
| kaido.to | video | error:timeout |  |  |  |  |
| kakaopage.com | reading | moved → page.kakao.com |  |  |  |  |
| kakuyomu.jp | reading | ok | likely | 4 | [lien](https://kakuyomu.jp/works/1177354054882961666/episodes/1177354054882961674) (main) | vu : text chapter: 81 paragraphs, 3 886 characters in .widget-episodeBody, episode navigation ; episode path /works/<id>/episodes/<id>; not in the link patterns |
| kickassanime.mx | video | error:timeout |  |  |  |  |
| kiryuu.to | reading | challenge | sample-challenge |  | [lien](https://v7.kiryuu.to/manga/forget-that-night-your-majesty/chapter-19.806955/) (main) | vu : big 16 of 30 images, lazy-loaded from cdn.uqni.net, custom tailwind layout (no #readerarea) ; kiryuu.io is a landing page; the reader lives on v7.kiryuu.to, which the rules do not list |
| kmanga.kodansha.com | reading | ok | likely | 4 | [lien](https://kmanga.kodansha.com/title/10011/episode/317222) |  |
| komiku.org | reading | error:timeout |  |  |  |  |
| kunmanga.com | reading | http:403 |  |  |  |  |
| lectormanga.com | reading | error:ENOTFOUND |  |  |  |  |
| leercapitulo.co | reading | http:403 |  |  |  |  |
| lelscanfr.com | reading | challenge |  |  |  |  |
| lelscans.net | reading | ok | ready | 30 | [lien](https://lelscans.net/lecture-en-ligne-one-piece) |  |
| lezhinus.com | reading | error:timeout |  |  |  |  |
| lightnovelpub.com | reading | http:403 |  |  |  |  |
| lightnovelspot.com | reading | error:timeout |  |  |  |  |
| lightnovelworld.com | reading | http:403 |  |  |  |  |
| lnmtl.com | reading | ok | likely | 0 | [lien](https://lnmtl.com/chapter/chaotic-sword-god-chapter-4242) |  |
| luminousscans.net | reading | moved → xml-v4.pushub.net |  |  |  |  |
| maid.my.id | reading | ok | ready | 43 | [lien](https://www.maid.my.id/undead-san-no-bukiyou-na-seishun-chapter-6-bahasa-indonesia/) |  |
| manga4life.com | reading | error:ENOTFOUND |  |  |  |  |
| mangabat.com | reading | error:timeout |  |  |  |  |
| mangabuddy.com | reading | moved → comizy.io |  |  |  |  |
| mangademon.org | reading | moved → comicdemons.com |  |  |  |  |
| mangadex.org | reading | ok | hand:blocked |  |  | blocked: the app bundle is cut by ERR_CONNECTION_RESET from this network; the reader is built in JavaScript (chapter pages are /chapter/<uuid>) |
| mangadistrict.com | reading | ok | ready | 27 | [lien](https://mangadistrict.com/series/exiled-palace-flowers/chapter-26/) |  |
| mangaeden.com | reading | error:timeout |  |  |  |  |
| mangafire.to | reading | challenge |  |  |  |  |
| mangafox.fun | reading | challenge |  |  |  |  |
| mangafreak.net | reading | moved → ww3.mangafreak.me |  |  |  |  |
| mangago.me | reading | http:403 |  |  |  |  |
| mangahasu.se | reading | error:certificate |  |  |  |  |
| mangahere.cc | reading | error:timeout | sample-error:timeout |  | [lien](https://www.mangahere.cc/manga/star_martial_god_technique/c882/1.html) (main) | vu : one page image per address (zjcdn.mangahere.org/.../mp_001.jpg), 22 pages through a pager; not a strip ; a paginated reader: the detector's gallery floor is not met on any single page, so a page-by-page rule is needed before this site works |
| mangahub.io | reading | http:403 |  |  |  |  |
| mangajar.com | reading | error:timeout |  |  |  |  |
| mangakakalot.gg | reading | ok | sample-http:403 |  | [lien](https://www.mangakakalot.gg/manga/killing-darling-baby-ing/chapter-23) |  |
| mangalib.me | reading | http:403 |  |  |  |  |
| mangalivre.blog | reading | error:timeout |  |  |  |  |
| manganato.com | reading | error:timeout |  |  |  |  |
| mangaowl.to | reading | moved → zairuc.com |  |  |  |  |
| mangapanda.in | reading | http:526 |  |  |  |  |
| mangapill.com | reading | ok | ready | 114 | [lien](https://mangapill.com/chapters) |  |
| mangaplus.shueisha.co.jp | reading | ok | hand:blocked |  |  | blocked: the app bundle never finished loading from this network; the official viewer (/viewer/<id>) draws pages on a canvas from encrypted images, which the reader could not read anyway |
| mangaread.org | reading | ok | likely | 0 | [lien](https://www.mangaread.org/manga/i-killed-an-academy-player/chapter-140/) |  |
| mangareader.to | reading | error:timeout |  |  |  |  |
| mangas-origines.fr | reading | http:403 |  |  |  |  |
| mangas-origines.xyz | reading | moved → zairuc.com |  |  |  |  |
| mangaschan.net | reading | error:ENOTFOUND |  |  |  |  |
| mangatoon.mobi | reading | ok | ready | 51 | [lien](https://mangatoon.mobi/en/watch/1477993/99579) (main) | vu : 46 page images under .pictures img with data-src (en-c-pic-aliyun.mangatoon.mobi, reachable), a 450 px placeholder until scrolled into view ; episode links are click handlers; the episode path is /en/watch/<content>/<episode> |
| mangaturk.com | reading | error:timeout |  |  |  |  |
| mangaworld.ac | reading | error:timeout |  |  |  |  |
| mangaworld.bz | reading | error:timeout |  |  |  |  |
| manhuafast.com | reading | http:403 |  |  |  |  |
| manhuaplus.com | reading | http:500 |  |  |  |  |
| manhuaplus.org | reading | ok | likely | 0 | [lien](https://manhuaplus.org/manga/apotheosis/chapter-1301) |  |
| manhuaus.com | reading | http:403 |  |  |  |  |
| manhwa18.cc | reading | error:timeout |  |  |  |  |
| manhwaclan.com | reading | http:403 |  |  |  |  |
| manhwatop.com | reading | http:403 |  |  |  |  |
| mavanimes.co | video | ok |  |  |  |  |
| miruro.tv | video | http:403 |  |  |  |  |
| mixdrop.ag | video | ok |  |  |  |  |
| monoschinos2.com | video | error:timeout |  |  |  |  |
| movearnpre.com | video | error:timeout |  |  |  |  |
| mtlnovel.com | reading | error:timeout |  |  |  |  |
| munpia.com | reading | ok | hand:blocked |  |  | blocked: a React root that never filled from here (its scripts did not load); reading needs an account |
| natomanga.com | reading | ok | sample-http:403 |  | [lien](https://www.natomanga.com/manga/killing-darling-baby-ing/chapter-23) |  |
| neko-sama.fr | video | ok |  |  |  |  |
| nelomanga.net | reading | ok | sample-http:403 |  | [lien](https://www.nelomanga.net/manga/killing-darling-baby-ing/chapter-23) |  |
| nettruyenviet10.com | reading | http:403 |  |  |  |  |
| novelasligeras.net | reading | http:403 |  |  |  |  |
| novelbin.com | reading | error:timeout |  |  |  |  |
| novelbuddy.com | reading | moved → novelbuddy.me |  |  |  |  |
| novelfull.com | reading | http:403 |  |  |  |  |
| novelhall.com | reading | http:403 |  |  |  |  |
| novelmania.com.br | reading | challenge |  |  |  |  |
| novelpia.com | reading | ok | hand:blocked |  |  | blocked: an empty <body> from here; Novelpia reads only with an account anyway |
| novelraw.blogspot.com | reading | http:404 |  |  |  |  |
| noveltrove.com | reading | error:timeout |  |  |  |  |
| novelupdates.com | reading | error:timeout |  |  |  |  |
| novelusb.com | reading | challenge |  |  |  |  |
| novgo.co | reading | moved → zairuc.com |  |  |  |  |
| ogladajanime.pl | video | http:403 |  |  |  |  |
| olympusxyz.com | reading | ok | ready | 58 | [lien](https://olympusxyz.com/capitulo/133303/comic-guerra-de-extincion) (main) | vu : 58 page images in the markup (media.imagesolymp.xyz, loading=lazy, 600 px column); that CDN does not answer from this network so none rendered ; chapter paths are /capitulo/<id>/<slug>: Spanish, not in the link patterns |
| omegascans.org | reading | ok | likely | 2 | [lien](https://omegascans.org/series/believe-me-i-offer-you-my-first/chapter-59) |  |
| oneupload.to | video | ok |  |  |  |  |
| otakufr.co | video | ok |  |  |  |  |
| papadustream.football | video | error:timeout |  |  |  |  |
| piccoma.com | reading | ok | no-sample |  |  |  |
| poseidonscans.com | reading | challenge |  |  |  |  |
| putlockers.rip | video | error:timeout |  |  |  |  |
| raijin-scans.fr | reading | http:403 |  |  |  |  |
| ranobelib.me | reading | ok | hand:blocked |  |  | blocked: a JavaScript app that shows 'error code 1' from this network (its API did not answer); nothing to sample |
| ranobes.net | reading | ok | ready | 14 | [lien](https://ranobes.net/chapters/1207214/last) |  |
| rawkuma.net | reading | challenge | sample-challenge |  | [lien](https://rawkuma.net/manga/sakamoto-days/chapter-275.407871/) (main) | vu : big 13 of 31 images after scrolling (kuma.kyut.dev), more still loading ; rawkuma.com is now a directory page; the reader lives on rawkuma.net, which the rules do not list |
| readlightnovel.me | reading | error:timeout |  |  |  |  |
| readnovelfull.com | reading | error:timeout |  |  |  |  |
| reaperscans.com | reading | error:timeout |  |  |  |  |
| remanga.org | reading | error:timeout |  |  |  |  |
| resetscans.com | reading | moved → zairuc.com |  |  |  |  |
| rizzfables.com | reading | ok | likely | 1 | [lien](https://rizzfables.com/chapter/r2311170-top-tier-providence-chapter-225) |  |
| royalroad.com | reading | challenge |  |  |  |  |
| scan-manga.com | reading | http:404 |  |  |  |  |
| scan-vf.net | reading | challenge |  |  |  |  |
| scantrad.net | reading | error:timeout |  |  |  |  |
| scribblehub.com | reading | http:403 |  |  |  |  |
| sendvid.com | video | http:502 |  |  |  |  |
| shinigami.asia | reading | http:403 |  |  |  |  |
| sibnet.ru | video | error:timeout |  |  |  |  |
| skynovels.net | reading | challenge |  |  |  |  |
| slimeread.com | reading | error:timeout |  |  |  |  |
| streamtape.com | video | ok |  |  |  |  |
| sushiscan.fr | reading | ok | ready | 7 | [lien](https://sushiscan.fr/the-ruined-world-was-mistaken-for-a-game-chapitre-9/) |  |
| sushiscan.net | reading | http:403 |  |  |  |  |
| syosetu.com | reading | ok | ready | 6 | [lien](https://ncode.syosetu.com/n1571ko/1/) (main) | vu : text chapter: 458 paragraphs, 56 852 characters, next-episode link ; reading is on ncode.syosetu.com; episode path /<ncode>/<n>/ |
| tapas.io | reading | http:500 |  |  |  |  |
| tappytoon.com | reading | error:timeout |  |  |  |  |
| tioanime.com | video | ok |  |  |  |  |
| tl.rulate.ru | reading | error:timeout |  |  |  |  |
| toomics.com | reading | ok | likely | 5 | [lien](https://toomics.com/fr/webtoon/episode/toon/5197) |  |
| toonily.com | reading | http:403 |  |  |  |  |
| toonily.me | reading | moved → toontop.io |  |  |  |  |
| toonkor.one | reading | error:timeout |  |  |  |  |
| truyenqqko.com | reading | http:403 |  |  |  |  |
| trxs.cc | reading | ok | likely | 0 | [lien](https://www.trxs.cc/tongren/6201/1.html) (main) | vu : text chapter: 37 paragraphs, 1 307 characters in .read_chapterDetail (short chapters) ; chapter path /tongren/<book>/<n>.html; not in the link patterns |
| tumangaonline.com | reading | error:ENOTFOUND |  |  |  |  |
| tunovelaligera.com | reading | http:403 |  |  |  |  |
| turkanime.co | video | ok |  |  |  |  |
| unionmangas.yt | reading | error:timeout |  |  |  |  |
| uqload.co | video | http:403 |  |  |  |  |
| uqload.net | video | http:403 |  |  |  |  |
| uukanshu.com | reading | error:ECONNREFUSED |  |  |  |  |
| uzaymanga.com | reading | http:403 |  |  |  |  |
| vidmoly.me | video | ok |  |  |  |  |
| vidmoly.org | video | ok |  |  |  |  |
| vidmoly.to | video | ok |  |  |  |  |
| vido.lol | video | moved → zairuc.com |  |  |  |  |
| visortmo.com | reading | error:timeout |  |  |  |  |
| voidscans.net | reading | ok | likely | 5 | [lien](https://voidscans.net/read/6/57/) (main) | vu : 5 page images (beta.voidscans.net/manga/<slug>/<n>/001.png), site answers on http after a redirect ; a small custom site; series at /library/<id>, chapters at /read/<id>/<n> |
| voiranime.com | video | error:timeout |  |  |  |  |
| voiranime.io | video | error:timeout |  |  |  |  |
| voiranime.net | video | ok |  |  |  |  |
| voiranime.rip | video | ok |  |  |  |  |
| voiranime.tv | video | error:timeout |  |  |  |  |
| vostfree.tv | video | ok |  |  |  |  |
| wakanim.tv | video | http:403 |  |  |  |  |
| webcomicsapp.com | reading | ok | likely | 3 | [lien](https://www.webcomicsapp.com/en/fantasy/goblin-s-ascent-from-loser-to-winner/1/67e20b7662661d12a148fa62) (main) | vu : big 15 after scrolling (imgg.mangaina.com), 319 <img> on the page with recommendations ; chapter list is click handlers, not links; chapter path is /en/<genre>/<slug>/<n>/<id> |
| webnovel.com | reading | http:403 |  |  |  |  |
| webtoon.xyz | reading | http:403 |  |  |  |  |
| webtoons.com | reading | ok | no-sample |  |  |  |
| webtoonscan.com | reading | http:403 |  |  |  |  |
| webtoontr.net | reading | error:timeout |  |  |  |  |
| weebcentral.com | reading | challenge |  |  |  |  |
| weebcentral.io | reading | error:timeout |  |  |  |  |
| wtr-lab.com | reading | challenge |  |  |  |  |
| wuxiabox.com | reading | http:403 |  |  |  |  |
| wuxiaworld.com | reading | error:timeout |  |  |  |  |
| wuxiaworld.site | reading | challenge |  |  |  |  |
| yugen.to | video | error:timeout |  |  |  |  |
| zonatmo.com | reading | error:timeout |  |  |  |  |
| zoro.to | video | error:timeout |  |  |  |  |
| zscans.com | reading | error:timeout |  |  |  |  |
