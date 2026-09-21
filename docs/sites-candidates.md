# Sites candidats

Généré par `node scripts/check-sites.mjs --candidates`. Dernière vérification : **2026-09-21**. Ne pas éditer à la main.

Les cinquante sites les plus cités par catégorie dans les index communautaires (fmhy.net, wotaku.wiki), plus les sites français déjà connus, vérifiés comme le registre : la page d'accueil, puis un chapitre (lecture) ou un épisode (vidéo). Pour un site de lecture, le verdict est celui de `shared/compat.js` sur la page échantillon. Pour un site vidéo, `player` veut dire que la page d'épisode porte ce sur quoi la barre vidéo se pose (une `<video>`, un lecteur en iframe d'un hôte connu, un sélecteur d'épisodes) ; `no-player` qu'elle a répondu sans rien de tel dans son balisage (un lecteur construit en JavaScript : à ouvrir à la main). `known` : déjà dans `shared/detection-rules.json`.

Depuis ce PC, `challenge`, `timeout` et `http:403` ne condamnent pas un site : l'antivirus et le FAI en bloquent une partie, et un téléphone sur un autre réseau les voit.

La colonne **Navigateur** est ce qu'une personne a vu en ouvrant le site dans un vrai navigateur (le 20 septembre, depuis ce PC) : `player` : la page d'épisode porte une `<video>`, un lecteur en iframe ou un sélecteur d'épisodes ; `ready`, `ready-text`, `likely` : la page rendue montre des scans, ou de la prose ; `paginated` : un scan par adresse, un mode page par page à écrire ; `wall` : un Turnstile Cloudflare ou un mur que l'on ne contourne pas ; `no-sample` : une application JavaScript dont l'accueil ne lie aucun épisode ni chapitre ; `down`, `dead`, `blocked` : le site ne répond pas, est parqué, ou ce navigateur a refusé d'y aller.

## Anime (la barre vidéo)

51 sites. no-sample 15 · challenge 15 · error:timeout 8 · no-player 8 · http:403 2 · sample-http:403 1 · http:521 1 · http:429 1.

| Domaine | Connu | Accueil | Script | Navigateur | Ce qui a été vu | Échantillon |
|---|---|---|---|---|---|---|
| 123animehub.cc |  | error:timeout |  |  |  |  |
| 1ani.me |  | ok | no-sample |  |  |  |
| allmanga.to |  | ok | no-sample | no-sample | JavaScript app, 17 links |  |
| anichan.to |  | ok | no-player |  |  | [lien](https://anichan.to/anime/178789/mushoku-tensei-jobless-reincarnation-season-3/1) |
| aniclipse.com |  | challenge |  |  |  |  |
| anidao.to |  | error:timeout |  |  |  |  |
| anidap.lol |  | ok | no-sample | no-sample | JavaScript app, 34 links, none shaped like an episode or a series |  |
| anidoor.me |  | challenge |  | no-sample | JavaScript app; the home page links searches only |  |
| anify.to |  | ok | sample-http:403 | down | the home page redirects to /error | [lien](https://anify.to/watch/5590/tales-of-herding-gods/101) |
| anihq.cc |  | challenge |  | player | frame voe.sx; /watch/<slug>-episode-12-english-subbed/ | [lien](https://anihq.cc/watch/mahou-shoujo-lyrical-nanoha-exceeds-gun-blaze-vengeance-episode-12-english-subbed/) |
| anikototv.to |  | ok | no-player | player-late | episode page /watch/<slug>/ep-1 answers, no player frame after 9 s (built later or on click) | [lien](https://anikototv.to/watch/solo-leveling-season-2-arise-from-the-shadow-3eukp/ep-1) |
| anikuro.to |  | ok | no-player | player | two <video> plus frame embed.yaply.net; /watch/<id>:<ep> | [lien](https://anikuro.to/watch/182205%3A1) |
| anilight.live |  | challenge |  | player | frame theanimecommunity.com; /watch/<slug>?ep=1 (episode in the query) | [lien](https://anilight.live/watch/yomi-no-tsugai?ep=1&server=light&lang=sub) |
| anime.nexus |  | challenge |  | no-sample | JavaScript app; /latest renders no anchors |  |
| animeonsen.xyz |  | challenge |  |  |  |  |
| animepahe.pw |  | http:403 |  | wall | Cloudflare Turnstile (checkbox) |  |
| animeparadise.moe |  | ok | no-player | player | a <video> in the page; /watch/<uuid>?origin=<id> | [lien](https://www.animeparadise.moe/watch/996b4f85-5f08-4ac5-a258-f67884589a29?origin=676354178f512e5d540d60b8) |
| animesilo.cc |  | http:521 |  |  |  |  |
| animesuge.cz |  | ok | no-player | player | player frame megaplay.buzz; /anime/<slug>/ep-48 | [lien](https://animesuge.cz/anime/digimon-beatbreak-u2o7s/ep-48) |
| animex.one |  | challenge |  | player | player frame plyr.animex.one; /watch/<slug>-episode-1 | [lien](https://animex.one/watch/the-summer-hikaru-died-177689-episode-1) |
| anisnatch.top |  | challenge |  | blocked | navigation refused by this browser |  |
| anistream.one |  | ok | no-sample | player | player frame aniembed.se; /watch/<slug>-episode-7 (from /home) | [lien](https://anistream.one/watch/mushoku-tensei-jobless-reincarnation-season-3-178789-episode-7) |
| anitaku.online |  | error:timeout |  | down | database error page |  |
| anivibe.live |  | error:timeout |  | down | database error page |  |
| aniwatchtv.cx |  | error:timeout |  | down | the server answers a PHP database error (SQLSTATE connection refused); same backend as gogoanimez, anivibe, hianime.ad, anitaku |  |
| anizone.to |  | challenge |  | no-sample | JavaScript app; /episode is an index with no anchors |  |
| enma.lol |  | ok | no-sample | dead | the site sends an automated browser to a YouTube video |  |
| fireani.me |  | ok | no-player |  |  | [lien](https://fireani.me/new-episodes/1) |
| franime.fr | oui | challenge |  | player | player in a same-origin frame; episode in the query: /anime/<slug>?s=1&ep=12 (episodeNumber must read ?ep=) | [lien](https://franime.fr/anime/black-torch?s=1&ep=12&lang=vo&anime_id=49656) |
| gogoanimez.cc |  | error:timeout |  | down | redirects to www1.gogoanime.pw, which answers the same database error |  |
| hianime.ad |  | error:timeout |  | down | database error page (a mirror, not the real hianime) |  |
| justanime.to |  | ok | no-sample | player | <video> plus frame theanimecommunity.com; /watch/<id>/<slug>/episode/1 | [lien](https://justanime.to/watch/201514/rich-girl-caretaker-im-secretly-the-caregiver-of-the-most-popular-girl-in-this-rich-kid-school/episode/1) |
| kaa.lt |  | challenge |  | player | player frame krussdomi.com; episode address /<slug>/ep-34-<id> | [lien](https://kaa.lt/meitantei-precure-b522/ep-34-3180cf) |
| kawaiianime.cc |  | ok | no-sample | no-sample | JavaScript app (Arabic); /browse renders no anchors |  |
| kazora.cc |  | challenge |  | no-sample | JavaScript app; /list is a watchlist that needs an account |  |
| kuroanime.lol |  | http:429 |  | wall | Cloudflare 'temporarily rate limited' |  |
| kyren.moe |  | challenge |  |  |  |  |
| luffytv.live |  | ok | no-sample | no-sample | no anchors at all after 5 s (Hindi/Tamil dubs site) |  |
| lunarx.to |  | challenge |  | crash | the page closed the browser pane (a script that breaks the tab) |  |
| meguanime.com |  | ok | no-sample | no-sample | JavaScript app: neither / nor /home renders a link to an episode |  |
| miruro.to |  | http:403 |  | wall | Cloudflare Turnstile |  |
| mkissa.to |  | ok | no-sample | no-sample | JavaScript app, 7 links on the home page |  |
| neko-sama.fr | oui | ok | no-sample | down | an empty document after 12 s |  |
| nekowatch.xyz |  | error:timeout |  | player | a <video> in the page; /watch/<id> | [lien](https://nekowatch.xyz/watch/210031) |
| otakufr.co | oui | ok | no-sample | blocked | navigation refused by this browser |  |
| reanime.to |  | challenge |  | no-sample | a landing page whose catalogue (/home) is rendered by JavaScript |  |
| reindex.to |  | ok | no-sample |  |  |  |
| senshi.to |  | ok | no-sample | player | a <video> in the page; /watch/<id>/<ep> | [lien](https://senshi.to/watch/61169/1) |
| voiranime.rip | oui | ok | no-player | player | frame video.sibnet.ru (listed); /<slug>/saison-4/episode-1/ | [lien](https://voiranime.rip/ace-of-diamond/saison-4/episode-1/) |
| yenime.net |  | ok | no-sample |  |  |  |
| yomi.to |  | ok | no-player | player | frame megaplay.buzz; /watch/<slug>-<id>/<ep> | [lien](https://yomi.to/watch/daemons-of-the-shadow-realm-195600/1) |

## Manga

47 sites. ready 9 · http:403 9 · no-sample 8 · challenge 6 · sample-http:403 4 · error:timeout 4 · sample-challenge 2 · hand:blocked 2 · unlikely 2 · http:404 1.

| Domaine | Connu | Accueil | Script | Navigateur | Ce qui a été vu | Échantillon |
|---|---|---|---|---|---|---|
| anime-sama.to | oui | ok | sample-challenge |  |  | [lien](https://anime-sama.to/catalogue/hardcore-leveling-warrior/scan-earth-game/va/) |
| atsu.moe |  | ok | no-sample | no-sample | JavaScript app (/explore), cards are not links |  |
| comick.dev | oui | http:403 | sample-http:403 |  |  ; comick.cc is parked (an ad redirect); comick.io redirects to comick.dev, which the rules do not list | [lien](https://comick.dev/comic/00-solo-max-level-newbie/EUlnpbT_-chapter-277-en) |
| comix.to |  | challenge |  | wall | its own security check (/@waf/challenge) |  |
| fanfox.net |  | ok | no-sample |  |  |  |
| fmteam.fr | oui | ok | ready |  | 20 images ; chapter path /read/<slug>/<lang>/ch/<n>; series list at /mangas | [lien](https://fmteam.fr/read/kingdom/fr/ch/888) |
| japscan.foo | oui | http:403 |  | wall | Cloudflare 'Access denied' for this IP |  |
| justmanga.cc |  | error:timeout |  |  |  |  |
| kagane.to |  | http:403 |  | wall | Cloudflare 'Attention required' (this IP refused) |  |
| lelmanga.com |  | challenge |  | ready | Themesia (#readerarea), 15 page images loading slowly; /<slug>-220 (no chapter word in the address, the title says Chapitre 220) | [lien](https://www.lelmanga.com/fairy-tail-100-years-quest-220) |
| lelscans.net | oui | ok | ready |  | 30 images | [lien](https://lelscans.net/lecture-en-ligne-one-piece) |
| likemanga.ink |  | ok | ready |  | 14 images | [lien](https://likemanga.ink/the-curse-is-kind-and-my-childhood-friend-is-delicious-40475/chapter-27-1828079/) |
| mangaball.net |  | http:403 |  |  |  |  |
| mangaberri.com |  | ok | ready |  | 15 images | [lien](https://mangaberri.com/read/45284) |
| mangadex.org | oui | ok | hand:blocked |  |  ; blocked: the app bundle is cut by ERR_CONNECTION_RESET from this network; the reader is built in JavaScript (chapter pages are /chapter/<uuid>) |  |
| mangadot.net |  | http:403 |  |  |  |  |
| mangafire.to | oui | challenge |  | ready | a JavaScript reader that adds <img> as you scroll (6 big after 8 s, m3z.mfcdn3.xyz); /title/<slug>/chapter/<id>, the number in the title | [lien](https://mangafire.to/title/ro8ro-all-class-awakening-god-slayer/chapter/9436393) |
| mangago.me | oui | http:403 |  | paginated | one page per address (/read-manga/<slug>/uu/br_chapter-<id>/pg-1/): needs the page-by-page mode | [lien](https://www.mangago.me/read-manga/the_boundary_of_delusion/uu/br_chapter-438912/pg-1/) |
| mangahere.cc | oui | ok | ready |  | 17 images ; a paginated reader: the detector's gallery floor is not met on any single page, so a page-by-page rule is needed before this site works | [lien](https://www.mangahere.cc/manga/star_martial_god_technique/c882/1.html) |
| mangahub.io | oui | http:403 |  |  |  |  |
| mangak.io |  | ok | no-sample |  |  |  |
| mangakakalot.gg | oui | ok | sample-http:403 | sample-wall | the home page answers, the chapter page is behind Cloudflare | [lien](https://www.mangakakalot.gg/manga/bad-gods-around-me/chapter-108) |
| mangakatana.com |  | ok | no-sample | ready | 38 page images (lazy) plus ad frames; /manga/<slug>.<id>/c59 (the chapter number only in the title) | [lien](https://mangakatana.com/manga/reiwa-no-dara-san.26987/c59) |
| mangamoins.shop |  | error:timeout |  | blocked | navigation refused by this browser |  |
| manganato.gg |  | ok | ready | ready | 136 page images | [lien](https://www.manganato.gg/manga/finding-humanity/chapter-15) |
| mangapark.net |  | error:timeout |  | dead | redirects to an advertising host (amourwavesonline.online) |  |
| mangapill.com | oui | ok | ready |  | 115 images | [lien](https://mangapill.com/chapters) |
| mangaplus.shueisha.co.jp | oui | ok | hand:blocked |  |  ; blocked: the app bundle never finished loading from this network; the official viewer (/viewer/<id>) draws pages on a canvas from encrypted images, which the reader could not read anyway |  |
| mangaread.org | oui | ok | ready |  | 62 images | [lien](https://www.mangaread.org/manga/other-world-warrior/chapter-357/) |
| mangareader.to | oui | error:timeout |  | down | Cloudflare 522, origin down |  |
| mangas-origines.fr | oui | http:403 |  | ready | 44 page images in the markup (lazy), ad frames from relieved-understanding.com; /oeuvre/<slug>/chapitre-52/ | [lien](https://mangas-origines.fr/oeuvre/emperor-of-solo-play/chapitre-52/) |
| mangascan-fr.com |  | ok | no-sample |  |  |  |
| mangataro.org |  | ok | no-sample |  |  |  |
| mangatown.com |  | ok | no-sample |  |  |  |
| mgeko.cc |  | ok | ready |  | 59 images | [lien](https://www.mgeko.cc/reader/en/rvdh-the-fight-is-too-easy-chapter-1-eng-li/) |
| natomanga.com | oui | ok | sample-http:403 |  |  | [lien](https://www.natomanga.com/manga/bad-gods-around-me/chapter-108) |
| nelomanga.net | oui | ok | sample-http:403 |  |  | [lien](https://www.nelomanga.net/manga/bad-gods-around-me/chapter-108) |
| onisaga.com |  | http:403 |  |  |  |  |
| rawkuma.net | oui | challenge | sample-challenge |  |  ; rawkuma.com is now a directory page; the reader lives on rawkuma.net, which the rules do not list | [lien](https://rawkuma.net/manga/sakamoto-days/chapter-275.407871/) |
| reaper-scans.fr |  | ok | no-sample | down | an empty document, no links |  |
| scan-manga.com | oui | http:404 |  | down | 404 on the home page |  |
| scan-vf.net | oui | challenge |  | paginated | one scan per address (1644x2400), 17 pages through a <select>: needs the page-by-page mode, like mangahere | [lien](https://www.scan-vf.net/one_piece/chapitre-1193) |
| scans.gg |  | challenge |  |  |  |  |
| sushiscan.net | oui | http:403 |  | wall | Cloudflare 'Un instant' on the home page |  |
| weebcentral.com | oui | challenge |  | ready | 24 page images (scans.lastation.us, slow from here); /chapters/<id>, the chapter number in the title | [lien](https://weebcentral.com/chapters/01M2YESGEYH7NEGXR8B8188JC6) |
| zazamanga.com |  | ok | unlikely |  | 0 images | [lien](https://www.zazamanga.com/css/chapter-report.css) |
| zinmanga.net |  | ok | unlikely |  | 0 images | [lien](https://www.zinmanga.net/css/chapter-report.css) |

## Light novels

50 sites. http:403 13 · error:timeout 11 · challenge 11 · no-sample 7 · ready 5 · likely 3.

| Domaine | Connu | Accueil | Script | Navigateur | Ce qui a été vu | Échantillon |
|---|---|---|---|---|---|---|
| allnovel.org |  | http:403 |  |  |  |  |
| alphapolis.co.jp | oui | ok | likely |  | 0 images ; episode path /novel/<author>/<work>/episode/<id> | [lien](https://www.alphapolis.co.jp/novel/500033287/535917677/episode/8971219) |
| baka-tsuki.org |  | ok | no-sample |  |  |  |
| bestlightnovel.com |  | error:timeout |  |  |  |  |
| chireads.com |  | ok | ready |  | 0 images | [lien](https://chireads.com/translatedtales/necromancien-je-suis-un-cataclysme-%e6%ad%bb%e7%81%b5%e6%b3%95%e5%b8%88%ef%bc%81%e6%88%91%e5%8d%b3%e6%98%af%e5%a4%a9%e7%81%be/chapitre-557-nouvelle-competence-invocation-du-roi-squelette/2026/09/20/) |
| creativenovels.com |  | error:timeout |  |  |  |  |
| cyrisia.com |  | ok | no-sample |  |  |  |
| freewebnovel.com | oui | http:403 |  |  |  |  |
| harkenscans.com |  | error:timeout |  |  |  |  |
| kakuyomu.jp | oui | ok | likely |  | 4 images ; episode path /works/<id>/episodes/<id>; not in the link patterns | [lien](https://kakuyomu.jp/works/1177354054882961666/episodes/1177354054882961674) |
| lightnovel.fr |  | error:timeout |  |  |  |  |
| lightnovelcave.com |  | error:timeout |  |  |  |  |
| lightnovelheaven.com |  | challenge |  |  |  |  |
| lightnovelpub.com | oui | http:403 |  |  |  |  |
| lightnovelworld.org |  | challenge |  | down | Cloudflare 522, origin down |  |
| lnmtl.com | oui | ok | ready |  | 0 images | [lien](https://lnmtl.com/chapter/chaotic-sword-god-chapter-4243) |
| lnori.com |  | challenge |  |  |  |  |
| mtlnovel.com | oui | error:timeout |  |  |  |  |
| novel-fr.com |  | error:timeout |  |  |  |  |
| novelarchive.cc |  | ok | no-sample |  |  |  |
| novelbin.com | oui | error:timeout |  | blocked | navigation refused by this browser |  |
| novelbin.me |  | error:timeout |  |  |  |  |
| novelbuddy.me |  | ok | no-sample |  |  |  |
| novelcool.com |  | ok | ready |  | 10 images | [lien](https://www.novelcool.com/chapter/Ch-191/14856300.html) |
| novelfire.net |  | challenge |  |  |  |  |
| novelfull.com | oui | http:403 |  |  |  |  |
| novelgo.id |  | http:403 |  |  |  |  |
| novelhall.com | oui | http:403 |  |  |  |  |
| novelphoenix.com |  | challenge |  |  |  |  |
| novels.pl |  | ok | no-sample |  |  |  |
| novelupdates.com | oui | http:403 |  |  |  |  |
| novelyra.com |  | http:403 |  |  |  |  |
| novgo.net |  | challenge |  |  |  |  |
| ranobes.top |  | http:403 |  |  |  |  |
| readlightnovel.me | oui | error:timeout |  |  |  |  |
| readnovelfull.com | oui | ok | ready |  | 0 images | [lien](https://readnovelfull.com/welcome-to-the-multiverse-group-chat/chapter-407-chapter-403-heathcliff.html) |
| rechapters.com |  | ok | no-sample |  |  |  |
| royalroad.com | oui | challenge |  | ready-text | 11 paragraphs, 2 083 characters, with 7 large cover images on the page (a risk of being read as a gallery); /fiction/<id>/<slug>/chapter/<id>/<slug> | [lien](https://www.royalroad.com/fiction/161190/an-unwritten-story-villainous-power-couple-litrpg/chapter/3985827/aus-origins-the-ravels) |
| scribblehub.com | oui | http:403 |  | wall | Cloudflare 'Attention required' for this IP |  |
| syosetu.com | oui | ok | ready |  | 6 images ; reading is on ncode.syosetu.com; episode path /<ncode>/<n>/ | [lien](https://ncode.syosetu.com/n1571ko/1/) |
| webnovel.com | oui | http:403 |  | ready-text | 75 paragraphs, 9 899 characters; /fr/book/<slug>_<id>/chapitre-1-<slug>_<id> | [lien](https://www.webnovel.com/fr/book/chacun-est-un-seigneur-mon-talent-est-un-peu-trop-fort_33572867908031605/chapitre-1-travers%C3%A9e-mondiale-un-milliard-de-seigneurs_90746099744175877) |
| wtr-lab.com | oui | challenge |  |  |  |  |
| wuxia.click |  | ok | no-sample |  |  |  |
| wuxiabox.com | oui | http:403 |  |  |  |  |
| wuxiadreams.com |  | challenge |  |  |  |  |
| wuxiaspot.com |  | http:403 |  |  |  |  |
| wuxiaworld.com | oui | challenge |  |  |  |  |
| wuxiaworld.eu |  | error:timeout |  |  |  |  |
| wuxiaworld.site | oui | challenge |  |  |  |  |
| xiaowaz.fr |  | ok | likely |  | 4 images | [lien](https://xiaowaz.fr/articles/og-chapitre-964/) |

## Webcomics et webtoons

50 sites. error:timeout 16 · moved 9 · http:403 9 · no-sample 7 · ready 4 · challenge 3 · likely 1 · error:ENOTFOUND 1.

| Domaine | Connu | Accueil | Script | Navigateur | Ce qui a été vu | Échantillon |
|---|---|---|---|---|---|---|
| asuracomic.net | oui | moved → asurascans.com |  | ready | redirects to asurascans.com (listed); 21 page images, 6 big after 8 s; /comics/<slug>-<hash>/chapter/6 | [lien](https://asurascans.com/comics/ode-of-the-brave-6f7fe6eb/chapter/6) |
| bato.to | oui | error:timeout |  | blocked | navigation refused by this browser |  |
| cosmic-scans.com |  | ok | no-sample |  |  |  |
| delitoon.com |  | moved → lezhinfr.com |  |  |  |  |
| drakecomic.org |  | moved → drakecomic.net |  |  |  |  |
| flamecomics.xyz | oui | challenge |  | likely | the probe landed on a series page (/series/2) full of page thumbnails; chapters are /series/<id>/<chapter> and the site is a JavaScript app | [lien](https://flamecomics.xyz/series/2) |
| globalcomix.com |  | error:timeout |  |  |  |  |
| harimanga.me |  | ok | no-sample |  |  |  |
| hivetoons.org |  | challenge |  |  |  |  |
| inkr.com | oui | ok | likely |  | 2 images | [lien](https://comics.inkr.com/title/4910-blue-lock-episode-nagi?ref=section_new_noteworthy_home) |
| kingofshojo.com |  | ok | ready |  | 119 images | [lien](https://kingofshojo.com/how-to-make-a-loving-savior-an-emperor-chapter-39/) |
| komiku.id |  | moved → komiku.org |  |  |  |  |
| kunmanga.com | oui | http:403 |  |  |  |  |
| lezhinus.com | oui | error:timeout |  |  |  |  |
| luminousscans.net | oui | moved → xml-v4.pushub.net |  |  |  |  |
| mangabuddy.com | oui | moved → comizy.io |  | ready | redirects to comizy.io (not listed); 11 page images all loaded; /<slug>/chapter-132 | [lien](https://comizy.io/hells-paradise-jigokuraku/chapter-132) |
| mangaclash.org |  | ok | no-sample |  |  |  |
| mangagalaxy.me |  | moved → xml-v4.pushub.net |  |  |  |  |
| manhuaplus.com | oui | challenge |  |  |  |  |
| manhuascan.com |  | ok | no-sample |  |  |  |
| manhuaus.com | oui | http:403 |  | wall | Cloudflare 'Un instant' |  |
| manhwa-freak.org |  | ok | no-sample |  |  |  |
| manhwa18.cc | oui | ok | ready |  | 33 images | [lien](https://manhwa18.cc/webtoon/the-magic-towers-problem-child/chapter-63) |
| manhwabuddy.com |  | ok | ready |  | 146 images | [lien](https://manhwabuddy.com/manhwa/reincarnator/chapter-152/) |
| manhwaclan.com | oui | http:403 |  |  |  |  |
| manhwafreak.com |  | error:timeout |  |  |  |  |
| manhwahub.net |  | error:ENOTFOUND |  |  |  |  |
| manhwaread.com |  | http:403 |  |  |  |  |
| manhwatop.com | oui | http:403 |  |  |  |  |
| nightscans.net |  | error:timeout |  |  |  |  |
| ononomangas.com |  | error:timeout |  |  |  |  |
| piccoma.fr |  | error:timeout |  |  |  |  |
| readmanhwa.com |  | error:timeout |  |  |  |  |
| reaperscans.com | oui | error:timeout |  |  |  |  |
| rizzfables.com | oui | ok | ready |  | 14 images | [lien](https://rizzfables.com/chapter/r2311170-top-tier-providence-chapter-225) |
| tapas.io | oui | error:timeout |  |  |  |  |
| tappytoon.com | oui | ok | no-sample |  |  |  |
| tapread.com |  | error:timeout |  |  |  |  |
| theblank.net |  | http:403 |  |  |  |  |
| toongod.org |  | http:403 |  |  |  |  |
| toonily.com | oui | http:403 |  | wall | Cloudflare 'Un instant' |  |
| toonily.me | oui | moved → toontop.io |  |  |  |  |
| toonkor.co |  | ok | no-sample |  |  |  |
| verytoon.com |  | error:timeout |  |  |  |  |
| voidscans.co |  | error:timeout |  |  |  |  |
| webtoon.fr |  | error:timeout |  |  |  |  |
| webtoon.xyz | oui | http:403 |  |  |  |  |
| webtoons.com | oui | error:timeout |  | ready | 103 page images in #_imageList (data-url, webtoon-phinf.pstatic.net), 102 loaded; /<lang>/<genre>/<slug>/ep-1/viewer?title_no=&episode_no= | [lien](https://www.webtoons.com/fr/romance/violet-romance/ep-1/viewer?title_no=9782&episode_no=2) |
| yakshascans.com |  | moved → t.co |  |  |  |  |
| zscans.com | oui | error:timeout |  |  |  |  |
