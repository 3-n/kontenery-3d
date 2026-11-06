# Budynek usługowy przy Terespolskiej: model 3D

Strona pokazuje projektowany kontenerowy budynek usługowy z zagospodarowaniem terenu (dz. ew. 4/1, obręb 3-02-08, ul. Terespolska, Warszawa) na trójwymiarowej mapie okolicy. Można zmieniać widok, datę i godzinę, żeby zobaczyć cienie, oraz włączać i wyłączać projekt.

To nieoficjalna wizualizacja poglądowa, a nie dokument projektowy.

## Skąd są dane

- **Bryła i zagospodarowanie:** projekt budowlany zatwierdzony decyzją nr 142/PPD/PB/2026 (rysunki Z-01, A-01 do A-04) oraz mapa do celów projektowych z 15.07.2026.
- **Położenie:** rysunek Z-01 dowiązany do krzyży siatki PL-2000 strefa 7 (EPSG:2178). Błąd dowiązania: 0,10 m RMS.
- **Granica działki do sprawdzenia:** usługa ULDK (GUGiK).
- **Mapa Google 3D (do wyboru przełącznikiem):** Google Photorealistic 3D Tiles przez Cesium ion, pobierana na żywo. Ta strona nie przechowuje żadnych danych tej mapy.
- **Mapa Geoportal (domyślna):** ortofotomapa GUGiK z 2025 r., pobierana na żywo z geoportal.gov.pl, oraz modele 3D budynków (LoD1, 2024) i drzew (LoD1, 2023) GUGiK. Modele są przycięte do około 800 m od działki i uproszczone: korony drzew mają jeden kształt, dopasowany do zmierzonej wysokości i szerokości, a budynki stoją na terenie z mapy do celów projektowych. Zapisane w pliku `surroundings.glb`.

## Dokładność

- Położenie względem geodezji: około ±0,2 m.
- Mapa 3D ma własny błąd: nałożona na nią granica działki zgadza się na oko do około metra.
- Wysokość modelu jest ustalana na żywo z wysokości mapy na otwartym trawniku obok budynku, a nie z rzędnych z rysunków.

**Odczytane z rysunków:** wymiary budynku, tarasu, parkingu i ścieżek, rzędne wysokości, położenie okien, drzwi i małej architektury.

**Szacunkowe, bo nieopisane w projekcie:** wysokość drzew, latarni i słupa ogłoszeniowego, gatunki i wielkość drzew, kolory wykończeń, przeszklenie drzwi.

**Tężnia:** obrys z mapy do celów projektowych, wysokości i wykończenie odczytane ze zdjęcia, które pokazuje trzy z ośmiu ścian. Pozostałe ściany przyjęto analogicznie. Tekstury są wygenerowane, a samo zdjęcie nie jest częścią modelu.

## Znane ograniczenia

- Mapa jest wycięta pod projektowanymi nawierzchniami, razem z fragmentami koron drzew nad nimi. Pozostałe drzewa zostają, bo projekt nie mówi, które będą usunięte.
- „Pokaż projekt” chowa tylko projekt: tężnia z nawierzchnią i młode drzewa wzdłuż ścieżki już są, więc zostają.
- Okna są nieprzezroczyste, bo wnętrze budynku nie jest modelowane.
- Zjazd na ul. Terespolską leży poza działką i nie należy do projektu (na planie jest opisany jako „w realizacji”), dlatego jest półprzezroczysty. Na mapie Google z bliska miejscami przebija przez niego trawnik.
- Ciemne plamy na zdjęciach mapy to cienie z dnia nalotu. Nie zmieniają się z godziną.
- Mapa Google nie jest aktualna: nie ma na niej m.in. istniejącej tężni ani nowego osiedla po drugiej stronie Terespolskiej.
- Mapa jest wczytywana tylko do około 800 m od działki, żeby strona działała płynnie. Dalej widać jednolite tło.
- Na mapie Geoportal budynki to proste bryły z płaskim dachem, a drzewa to uproszczone korony. Pochodzą ze skanowania z 2023 r., więc nowsze budynki widać tylko na zdjęciu.

## Uznanie autorstwa

Dane mapy: Google, widoczne na stronie razem z logo. Silnik: [CesiumJS](https://cesium.com/platform/cesiumjs/) (Apache 2.0), przez Cesium ion. Mapa Geoportal: ortofotomapa oraz modele 3D budynków i drzew GUGiK z geoportal.gov.pl, przetworzone jak opisano wyżej.
