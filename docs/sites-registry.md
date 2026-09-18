# Registre des sites

Généré par `node scripts/check-sites.mjs`. Dernière vérification : **2026-09-18**. Ne pas éditer à la main : relancer le script.

Chaque domaine de `shared/detection-rules.json` est visité une fois (page d'accueil), et pour les sites de lecture qui répondent, le premier lien de chapitre trouvé est passé à `shared/compat.js`, l'analyse que le lecteur lui-même exécute. Une ligne est une preuve datée, pas une promesse.

**Lire les colonnes.** `ok` : la page d'accueil répond. `challenge` : un mur anti-robot (Cloudflare) répond à la place de la page ; depuis un téléphone le site marche souvent, depuis ce PC non. `moved` : le domaine redirige vers un autre, l'entrée est périmée. `error:ENOTFOUND` : le domaine n'existe plus. `http:4xx/5xx` : le serveur refuse. Le verdict est celui du lecteur sur la page échantillon : `ready`/`likely` veut dire qu'il s'ouvrirait ; `no-sample` que la page d'accueil ne lie aucun chapitre (site à catalogue, ou lien à trouver à la main).

Accueil : ok 91 · error:timeout 78 · http:403 41 · challenge 26 · moved 16 · error:ENOTFOUND 5 · error:certificate 4 · http:404 2 · http:526 1 · http:500 1 · error:ECONNREFUSED 1.
Verdicts : no-sample 52 · ready 10 · likely 9 · sample-http:403 3.

| Domaine | Type | Accueil | Verdict | Images | Échantillon |
|---|---|---|---|---|---|
| 1stkissmanga.me | reading | error:certificate |  |  |  |
| 3asq.org | reading | moved → 3asq.online |  |  |  |
| 69shuba.com | reading | http:403 |  |  |  |
| 9animetv.to | video | error:timeout |  |  |  |
| agit.top | reading | error:timeout |  |  |  |
| allanime.to | video | error:timeout |  |  |  |
| allnovel.net | reading | error:timeout |  |  |  |
| alphapolis.co.jp | reading | ok | no-sample |  |  |
| anicloud.to | video | error:certificate |  |  |  |
| anilab.to | video | error:timeout |  |  |  |
| anime-sama.fr | video | error:timeout |  |  |  |
| anime-sama.org | video | error:timeout |  |  |  |
| animeblix.com | video | error:ENOTFOUND |  |  |  |
| animedao.to | video | ok |  |  |  |
| animedigitalnetwork.fr | video | error:timeout |  |  |  |
| animeflv.net | video | error:timeout |  |  |  |
| animeheaven.me | video | ok |  |  |  |
| animekai.to | video | error:timeout |  |  |  |
| animension.to | video | ok |  |  |  |
| animeowl.me | video | ok |  |  |  |
| animepahe.ru | video | moved → animepahe.su |  |  |  |
| animesama.fr | video | error:timeout |  |  |  |
| animesaturn.cx | video | challenge |  |  |  |
| animesgratis.org | video | ok |  |  |  |
| animesonlinecc.net | video | error:timeout |  |  |  |
| animesuge.to | video | error:timeout |  |  |  |
| animeunity.so | video | challenge |  |  |  |
| animexin.dev | video | error:timeout |  |  |  |
| aniwatchtv.to | video | error:timeout |  |  |  |
| aniwave.to | video | error:timeout |  |  |  |
| aniworld.to | video | ok |  |  |  |
| anix.to | video | error:certificate |  |  |  |
| asuracomic.net | reading | moved → asurascans.com |  |  |  |
| asurascans.com | reading | ok | ready | 35 | [lien](https://asurascans.com/comics/war-of-extinction-6f7fe6eb/chapter/7) |
| azorafly.com | reading | ok | likely | 0 | [lien](https://azorafly.com/series/celebrity-lady/chapter-89) |
| azuki.co | reading | moved → omoi.com |  |  |  |
| bato.to | reading | error:timeout |  |  |  |
| betteranime.net | video | ok |  |  |  |
| bilibili.tv | video | ok |  |  |  |
| bilibilicomics.com | reading | error:timeout |  |  |  |
| blacktoon.org | reading | ok | no-sample |  |  |
| boxnovel.com | reading | ok | no-sample |  |  |
| centralnovel.com | reading | http:403 |  |  |  |
| chapmanganato.to | reading | error:timeout |  |  |  |
| chrysanthemumgarden.com | reading | challenge |  |  |  |
| coffeemanga.io | reading | error:timeout |  |  |  |
| comick.cc | reading | ok | no-sample |  |  |
| comick.io | reading | http:403 |  |  |  |
| comico.jp | reading | ok | no-sample |  |  |
| comikey.com | reading | challenge |  |  |  |
| crunchyscan.fr | reading | error:timeout |  |  |  |
| desu-online.pl | video | ok |  |  |  |
| doodstream.com | video | ok |  |  |  |
| drakescans.com | reading | ok | no-sample |  |  |
| fanmtl.com | reading | http:403 |  |  |  |
| filemoon.sx | video | ok |  |  |  |
| flamecomics.xyz | reading | challenge |  |  |  |
| fmteam.fr | reading | ok | no-sample |  |  |
| foxaholic.com | reading | http:403 |  |  |  |
| franime.com | video | error:timeout |  |  |  |
| franime.fr | video | challenge |  |  |  |
| freewebnovel.com | reading | http:403 |  |  |  |
| genesistls.com | reading | ok | no-sample |  |  |
| gogoanime.by | video | error:timeout |  |  |  |
| gogoanimes.fi | video | moved → gogoanime.is |  |  |  |
| goyabu.to | video | moved → goyabu.io |  |  |  |
| harimanga.com | reading | ok | no-sample |  |  |
| hianime.to | video | error:timeout |  |  |  |
| hivetoon.com | reading | challenge |  |  |  |
| hostednovel.com | reading | challenge |  |  |  |
| ikigaimangas.com | reading | challenge |  |  |  |
| immortalupdates.com | reading | http:403 |  |  |  |
| inkr.com | reading | ok | likely | 2 | [lien](https://comics.inkr.com/title/4910-blue-lock-episode-nagi?ref=section_new_noteworthy_home) |
| inmanga.com | reading | challenge |  |  |  |
| iq.com | video | error:timeout |  |  |  |
| isotls.com | reading | ok | likely | 2 | [lien](https://www.isotls.com/novel/62cb747de619ae0a7ab21755/chapter/1735/update) |
| japscan.lol | reading | challenge |  |  |  |
| japscan.me | reading | ok | no-sample |  |  |
| jkanime.net | video | ok |  |  |  |
| joara.com | reading | ok | no-sample |  |  |
| kaido.to | video | error:timeout |  |  |  |
| kakaopage.com | reading | moved → page.kakao.com |  |  |  |
| kakuyomu.jp | reading | ok | no-sample |  |  |
| kickassanime.mx | video | error:timeout |  |  |  |
| kiryuu.io | reading | ok | no-sample |  |  |
| kmanga.kodansha.com | reading | ok | likely | 4 | [lien](https://kmanga.kodansha.com/title/10011/episode/317222) |
| komikcast.cz | reading | ok | no-sample |  |  |
| komiku.org | reading | error:timeout |  |  |  |
| kunmanga.com | reading | http:403 |  |  |  |
| lectormanga.com | reading | error:ENOTFOUND |  |  |  |
| leercapitulo.co | reading | http:403 |  |  |  |
| lelscan-vf.co | reading | ok | no-sample |  |  |
| lelscanfr.com | reading | challenge |  |  |  |
| lelscans.net | reading | ok | ready | 30 | [lien](https://lelscans.net/lecture-en-ligne-one-piece) |
| leomanga.xyz | reading | ok | no-sample |  |  |
| lezhinus.com | reading | error:timeout |  |  |  |
| lightnovelpub.com | reading | http:403 |  |  |  |
| lightnovelspot.com | reading | error:timeout |  |  |  |
| lightnovelworld.com | reading | http:403 |  |  |  |
| lnmtl.com | reading | ok | likely | 0 | [lien](https://lnmtl.com/chapter/chaotic-sword-god-chapter-4242) |
| luminousscans.net | reading | moved → xml-v4.pushub.net |  |  |  |
| maid.my.id | reading | ok | ready | 43 | [lien](https://www.maid.my.id/undead-san-no-bukiyou-na-seishun-chapter-6-bahasa-indonesia/) |
| manatoki.net | reading | ok | no-sample |  |  |
| manga4life.com | reading | error:ENOTFOUND |  |  |  |
| mangabat.com | reading | error:timeout |  |  |  |
| mangabuddy.com | reading | moved → comizy.io |  |  |  |
| mangaclash.com | reading | ok | no-sample |  |  |
| mangademon.org | reading | moved → comicdemons.com |  |  |  |
| mangadex.org | reading | ok | no-sample |  |  |
| mangadistrict.com | reading | ok | ready | 27 | [lien](https://mangadistrict.com/series/exiled-palace-flowers/chapter-26/) |
| mangaeden.com | reading | error:timeout |  |  |  |
| mangafire.to | reading | challenge |  |  |  |
| mangafox.fun | reading | challenge |  |  |  |
| mangafreak.net | reading | moved → ww3.mangafreak.me |  |  |  |
| mangageko.com | reading | ok | no-sample |  |  |
| mangago.me | reading | http:403 |  |  |  |
| mangahasu.se | reading | error:certificate |  |  |  |
| mangahere.cc | reading | ok | no-sample |  |  |
| mangahub.io | reading | http:403 |  |  |  |
| mangajar.com | reading | error:timeout |  |  |  |
| mangakakalot.gg | reading | ok | sample-http:403 |  | [lien](https://www.mangakakalot.gg/manga/a-boy-raised-by-the-ultimate-dragon-wants-to-be-fostered-by-someone-stronger-than-his-parent/chapter-40) |
| mangakomi.io | reading | ok | no-sample |  |  |
| mangalib.me | reading | http:403 |  |  |  |
| mangalivre.blog | reading | challenge |  |  |  |
| mangalivre.net | reading | ok | no-sample |  |  |
| mangamo.com | reading | ok | no-sample |  |  |
| manganato.com | reading | error:timeout |  |  |  |
| manganelo.tv | reading | ok | no-sample |  |  |
| mangaowl.to | reading | moved → zairuc.com |  |  |  |
| mangapanda.in | reading | http:526 |  |  |  |
| mangapark.io | reading | ok | no-sample |  |  |
| mangapill.com | reading | ok | ready | 114 | [lien](https://mangapill.com/chapters) |
| mangaplus.shueisha.co.jp | reading | ok | no-sample |  |  |
| mangaread.org | reading | ok | ready | 0 | [lien](https://www.mangaread.org/manga/my-girlfriend-gives-me-goosebumps/chapter-27/) |
| mangareader.to | reading | error:timeout |  |  |  |
| mangas-origines.fr | reading | http:403 |  |  |  |
| mangas-origines.xyz | reading | error:timeout |  |  |  |
| mangaschan.net | reading | error:ENOTFOUND |  |  |  |
| mangasee123.com | reading | ok | no-sample |  |  |
| mangatoon.mobi | reading | ok | no-sample |  |  |
| mangaturk.com | reading | http:403 |  |  |  |
| mangatx.com | reading | ok | no-sample |  |  |
| mangaworld.ac | reading | error:timeout |  |  |  |
| mangaworld.bz | reading | error:timeout |  |  |  |
| manhuafast.com | reading | http:403 |  |  |  |
| manhuaplus.com | reading | challenge |  |  |  |
| manhuaplus.org | reading | ok | likely | 0 | [lien](https://manhuaplus.org/manga/apotheosis/chapter-1301) |
| manhuaus.com | reading | http:403 |  |  |  |
| manhwa18.cc | reading | ok | ready | 33 | [lien](https://manhwa18.cc/webtoon/solo-max-level-newbie/chapter-277) |
| manhwaclan.com | reading | http:403 |  |  |  |
| manhwatop.com | reading | http:403 |  |  |  |
| manta.net | reading | ok | no-sample |  |  |
| mavanimes.co | video | error:timeout |  |  |  |
| miruro.tv | video | http:403 |  |  |  |
| mixdrop.ag | video | ok |  |  |  |
| monoschinos2.com | video | moved → monoschinos.st |  |  |  |
| movearnpre.com | video | error:timeout |  |  |  |
| mtlnovel.com | reading | error:timeout |  |  |  |
| munpia.com | reading | ok | no-sample |  |  |
| natomanga.com | reading | ok | sample-http:403 |  | [lien](https://www.natomanga.com/manga/a-boy-raised-by-the-ultimate-dragon-wants-to-be-fostered-by-someone-stronger-than-his-parent/chapter-40) |
| neko-sama.fr | video | error:timeout |  |  |  |
| nelomanga.net | reading | ok | sample-http:403 |  | [lien](https://www.nelomanga.net/manga/a-boy-raised-by-the-ultimate-dragon-wants-to-be-fostered-by-someone-stronger-than-his-parent/chapter-40) |
| netcomics.com | reading | ok | no-sample |  |  |
| nettruyenviet10.com | reading | http:403 |  |  |  |
| newtoki.com | reading | ok | no-sample |  |  |
| nightscans.org | reading | ok | no-sample |  |  |
| novelasligeras.net | reading | http:403 |  |  |  |
| novelbin.com | reading | error:timeout |  |  |  |
| novelbuddy.com | reading | moved → novelbuddy.me |  |  |  |
| novelfull.com | reading | http:403 |  |  |  |
| novelhall.com | reading | http:403 |  |  |  |
| novelmania.com.br | reading | challenge |  |  |  |
| novelnext.com | reading | ok | no-sample |  |  |
| novelpia.com | reading | ok | no-sample |  |  |
| novelraw.blogspot.com | reading | http:404 |  |  |  |
| noveltrove.com | reading | error:timeout |  |  |  |
| novelupdates.com | reading | http:403 |  |  |  |
| novelusb.com | reading | challenge |  |  |  |
| novgo.co | reading | moved → zairuc.com |  |  |  |
| ogladajanime.pl | video | http:403 |  |  |  |
| olympusxyz.com | reading | ok | no-sample |  |  |
| omegascans.org | reading | ok | likely | 2 | [lien](https://omegascans.org/series/im-the-only-guy-at-the-massage-shop/chapter-28) |
| oneupload.to | video | ok |  |  |  |
| otakufr.co | video | error:timeout |  |  |  |
| papadustream.football | video | error:timeout |  |  |  |
| phenix-scans.com | reading | ok | no-sample |  |  |
| piccoma.com | reading | error:timeout |  |  |  |
| pocketcomics.com | reading | ok | no-sample |  |  |
| poseidonscans.com | reading | challenge |  |  |  |
| putlockers.rip | video | error:timeout |  |  |  |
| raijin-scans.fr | reading | http:403 |  |  |  |
| ranobelib.me | reading | ok | no-sample |  |  |
| ranobes.net | reading | ok | ready | 14 | [lien](https://ranobes.net/chapters/1207214/last) |
| rawkuma.com | reading | ok | no-sample |  |  |
| readlightnovel.me | reading | error:timeout |  |  |  |
| readnovelfull.com | reading | ok | ready | 0 | [lien](https://readnovelfull.com/the-martial-unity/chapter-4513-the-first-battle-of-arima-iii.html) |
| realmscans.xyz | reading | ok | no-sample |  |  |
| reaperscans.com | reading | error:timeout |  |  |  |
| remanga.org | reading | error:timeout |  |  |  |
| resetscans.com | reading | error:timeout |  |  |  |
| ridibooks.com | reading | ok | no-sample |  |  |
| rizzfables.com | reading | ok | likely | 1 | [lien](https://rizzfables.com/chapter/r2311170-top-tier-providence-chapter-225) |
| royalroad.com | reading | challenge |  |  |  |
| scan-manga.com | reading | http:404 |  |  |  |
| scan-vf.net | reading | challenge |  |  |  |
| scantrad.net | reading | error:timeout |  |  |  |
| scribblehub.com | reading | http:403 |  |  |  |
| sendvid.com | video | error:timeout |  |  |  |
| shinigami.asia | reading | http:403 |  |  |  |
| sibnet.ru | video | error:timeout |  |  |  |
| skynovels.net | reading | challenge |  |  |  |
| slimeread.com | reading | error:timeout |  |  |  |
| starboundscans.com | reading | ok | no-sample |  |  |
| streamtape.com | video | ok |  |  |  |
| sushiscan.fr | reading | ok | ready | 7 | [lien](https://sushiscan.fr/the-ruined-world-was-mistaken-for-a-game-chapitre-9/) |
| sushiscan.net | reading | http:403 |  |  |  |
| sushiscan.su | reading | ok | no-sample |  |  |
| syosetu.com | reading | ok | no-sample |  |  |
| tapas.io | reading | http:500 |  |  |  |
| tappytoon.com | reading | error:timeout |  |  |  |
| tioanime.com | video | ok |  |  |  |
| tl.rulate.ru | reading | error:timeout |  |  |  |
| toomics.com | reading | ok | likely | 5 | [lien](https://toomics.com/fr/webtoon/episode/toon/8342) |
| toonily.com | reading | http:403 |  |  |  |
| toonily.me | reading | moved → toontop.io |  |  |  |
| toonkor.one | reading | error:timeout |  |  |  |
| truyenqqko.com | reading | http:403 |  |  |  |
| trxs.cc | reading | ok | no-sample |  |  |
| tumangaonline.com | reading | error:ENOTFOUND |  |  |  |
| tunovelaligera.com | reading | http:403 |  |  |  |
| turkanime.co | video | ok |  |  |  |
| unionmangas.yt | reading | error:timeout |  |  |  |
| uqload.co | video | http:403 |  |  |  |
| uqload.net | video | http:403 |  |  |  |
| uukanshu.com | reading | error:ECONNREFUSED |  |  |  |
| uzaymanga.com | reading | http:403 |  |  |  |
| vidmoly.me | video | error:timeout |  |  |  |
| vidmoly.org | video | error:timeout |  |  |  |
| vidmoly.to | video | error:timeout |  |  |  |
| vido.lol | video | error:timeout |  |  |  |
| visortmo.com | reading | error:timeout |  |  |  |
| viz.com | reading | ok | no-sample |  |  |
| voidscans.net | reading | ok | no-sample |  |  |
| voiranime.com | video | error:timeout |  |  |  |
| voiranime.io | video | error:timeout |  |  |  |
| voiranime.net | video | error:timeout |  |  |  |
| voiranime.rip | video | error:timeout |  |  |  |
| voiranime.tv | video | error:timeout |  |  |  |
| vostfree.tv | video | error:timeout |  |  |  |
| wakanim.tv | video | error:timeout |  |  |  |
| webcomicsapp.com | reading | ok | no-sample |  |  |
| webnovel.com | reading | http:403 |  |  |  |
| webtoon.xyz | reading | http:403 |  |  |  |
| webtoons.com | reading | error:timeout |  |  |  |
| webtoonscan.com | reading | http:403 |  |  |  |
| webtoontr.net | reading | error:timeout |  |  |  |
| weebcentral.com | reading | challenge |  |  |  |
| weebcentral.io | reading | error:timeout |  |  |  |
| wtr-lab.com | reading | challenge |  |  |  |
| wuxiabox.com | reading | http:403 |  |  |  |
| wuxiaworld.com | reading | challenge |  |  |  |
| wuxiaworld.site | reading | challenge |  |  |  |
| yugen.to | video | error:timeout |  |  |  |
| zeroscans.com | reading | ok | no-sample |  |  |
| zonatmo.com | reading | error:timeout |  |  |  |
| zoro.to | video | error:timeout |  |  |  |
