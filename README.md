# Budynek usługowy przy Terespolskiej: model 3D

Strona pokazuje projektowany kontenerowy budynek usługowy z zagospodarowaniem terenu (dz. ew. 4/1, obręb 3-02-08, ul. Terespolska, Warszawa) na trójwymiarowej mapie okolicy. Można zmieniać widok, datę i godzinę, żeby zobaczyć cienie, oraz włączać i wyłączać projekt.

To nieoficjalna wizualizacja poglądowa, a nie dokument projektowy.

## Skąd są dane

- **Bryła i zagospodarowanie:** projekt budowlany zatwierdzony decyzją nr 142/PPD/PB/2026 (rysunki Z-01, A-01 do A-04) oraz mapa do celów projektowych z 15.07.2026.
- **Położenie:** rysunek Z-01 dowiązany do krzyży siatki PL-2000 strefa 7 (EPSG:2178). Błąd dowiązania: 0,10 m RMS.
- **Granica działki do sprawdzenia:** usługa ULDK (GUGiK).
- **Mapa 3D:** Google Photorealistic 3D Tiles przez Cesium ion, pobierana na żywo. Ta strona nie przechowuje żadnych danych mapy.

## Dokładność

- Położenie względem geodezji: około ±0,2 m.
- Mapa 3D ma własny błąd: nałożona na nią granica działki zgadza się na oko do około metra.
- Wysokość modelu jest ustalana na żywo z wysokości mapy na otwartym trawniku obok budynku, a nie z rzędnych z rysunków.

**Odczytane z rysunków:** wymiary budynku, tarasu, parkingu i ścieżek, rzędne wysokości, położenie okien, drzwi i małej architektury.

**Szacunkowe, bo nieopisane w projekcie:** wysokość drzew, latarni i słupa ogłoszeniowego, gatunki i wielkość drzew, kolory wykończeń, przeszklenie drzwi. Tężnia to bryła zastępcza: projekt podaje tylko jej obrys.

## Znane ograniczenia

- Mapa jest wycięta pod projektowanymi nawierzchniami, razem z fragmentami koron drzew nad nimi. Pozostałe drzewa zostają, bo projekt nie mówi, które będą usunięte.
- Ciemne plamy na zdjęciach mapy to cienie z dnia nalotu. Nie zmieniają się z godziną.
- Mapa nie jest aktualna: nie ma na niej m.in. istniejącej tężni.

## Uznanie autorstwa

Dane mapy: Google, widoczne na stronie razem z logo. Silnik: [CesiumJS](https://cesium.com/platform/cesiumjs/) (Apache 2.0), przez Cesium ion. Podkład lokalny do testów: OpenStreetMap.
